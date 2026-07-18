import type { Browser, BrowserContext, Page } from 'playwright'
import type { SourceRow } from '../../core/types'

const mockLaunchPersistentContext = jest.fn()
const mockConnect = jest.fn()
const mockDbQuery = jest.fn()

jest.mock('playwright', () => ({
  chromium: {
    launchPersistentContext: (...args: unknown[]) => mockLaunchPersistentContext(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}))

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))

import { openSession } from '../fetcher'
import { acquireProfileLane } from '../profile-lanes'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function source(slug: string, fetchRegion: SourceRow['fetch_region'] = 'local'): SourceRow {
  return {
    id: 99,
    slug,
    fetch_region: fetchRegion,
    rate_budget_ms: 0,
    meta: {},
  } as SourceRow
}

function browserMock(closeImpl: () => Promise<void> = async () => undefined): {
  browser: Browser
  close: jest.Mock
  newContext: jest.Mock
} {
  const close = jest.fn(closeImpl)
  const newContext = jest.fn()
  return {
    browser: {
      close,
      newContext,
    } as Browser,
    close,
    newContext,
  }
}

function contextMock(options?: { browser?: Browser | null; close?: () => Promise<void> }): {
  context: BrowserContext
  page: Page
  close: jest.Mock
} {
  const frame = {}
  const pageClose = jest.fn(async () => undefined)
  const page = {
    isClosed: jest.fn(() => false),
    close: pageClose,
    on: jest.fn(),
    off: jest.fn(),
    mainFrame: jest.fn(() => frame),
    url: jest.fn(() => 'about:blank'),
    goto: jest.fn(),
    evaluate: jest.fn(),
  } as Page
  const close = jest.fn(options?.close ?? (async () => undefined))
  const context = {
    pages: jest.fn(() => [page]),
    newPage: jest.fn(async () => page),
    request: { dispose: jest.fn() },
    storageState: jest.fn(async () => ({ cookies: [], origins: [] })),
    close,
    browser: jest.fn(() => options?.browser ?? null),
  } as BrowserContext
  return { context, page, close }
}

async function nextMicrotask(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const tierCOptions = {
  profileLaneKey: 'tier-c',
  profileSuffix: 'tier-c',
  profileSlotCount: 2,
} as const

describe('persistent Chromium profile lanes', () => {
  beforeEach(() => {
    jest.useRealTimers()
    mockLaunchPersistentContext.mockReset()
    mockConnect.mockReset()
    mockDbQuery.mockReset()
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    process.env.INGEST_LOCAL_REGION = 'local'
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('rotates fixed slots instead of always preferring slot 1', async () => {
    const first = await acquireProfileLane('bybit_rotation', {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    })
    expect(first.profileSuffix).toBe('tier-c-1')
    first.release()

    const second = await acquireProfileLane('bybit_rotation', {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    })
    expect(second.profileSuffix).toBe('tier-c-2')
    second.release()

    const third = await acquireProfileLane('bybit_rotation', {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    })
    expect(third.profileSuffix).toBe('tier-c-1')
    third.release()
  })

  it('queues excess callers without creating a third directory', async () => {
    const config = {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    } as const
    const first = await acquireProfileLane('bybit_bounded', config)
    const second = await acquireProfileLane('bybit_bounded', config)
    let thirdResolved = false
    const thirdPromise = acquireProfileLane('bybit_bounded', config).then((lease) => {
      thirdResolved = true
      return lease
    })

    await nextMicrotask()
    expect(thirdResolved).toBe(false)
    first.release()

    const third = await thirdPromise
    expect(third.profileSuffix).toBe('tier-c-1')
    first.release() // idempotent
    second.release()
    third.release()
  })

  it('rejects current and future waiters when a single-slot lane is quarantined', async () => {
    const config = { laneKey: 'tier-a' } as const
    const first = await acquireProfileLane('bybit_quarantine_exhausted', config)
    const waiter = acquireProfileLane('bybit_quarantine_exhausted', config)
    const waiterRejected = expect(waiter).rejects.toThrow('has no healthy slots')
    await nextMicrotask()

    first.quarantine()

    await waiterRejected
    await expect(acquireProfileLane('bybit_quarantine_exhausted', config)).rejects.toThrow(
      'has no healthy slots'
    )
  })

  it('keeps partial healthy capacity after one slot is quarantined', async () => {
    const config = {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    } as const
    const first = await acquireProfileLane('bybit_partial_quarantine', config)
    const second = await acquireProfileLane('bybit_partial_quarantine', config)
    let waiterResolved = false
    const waiter = acquireProfileLane('bybit_partial_quarantine', config).then((lease) => {
      waiterResolved = true
      return lease
    })

    first.quarantine()
    await nextMicrotask()
    expect(waiterResolved).toBe(false)

    second.release()
    const replacement = await waiter
    expect(replacement.profileSuffix).toBe('tier-c-2')
    replacement.release()
  })

  it('rejects waiters only after every slot in a multi-slot lane is quarantined', async () => {
    const config = {
      laneKey: 'tier-c',
      profileSuffix: 'tier-c',
      slotCount: 2,
    } as const
    const first = await acquireProfileLane('bybit_full_quarantine', config)
    const second = await acquireProfileLane('bybit_full_quarantine', config)
    const waiter = acquireProfileLane('bybit_full_quarantine', config)
    const waiterRejected = expect(waiter).rejects.toThrow('has no healthy slots')

    first.quarantine()
    await nextMicrotask()
    second.quarantine()

    await waiterRejected
    await expect(acquireProfileLane('bybit_full_quarantine', config)).rejects.toThrow(
      'has no healthy slots'
    )
  })

  it('caps repeated launch-failure backoff and never hands a cooling slot immediately', async () => {
    jest.useFakeTimers()
    const config = { laneKey: 'tier-a' } as const
    let lease = await acquireProfileLane('bybit_backoff_cap', config)

    // Grow through 250/500/1000/2000/4000ms.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      lease.releaseAfterLaunchFailure()
      const next = acquireProfileLane('bybit_backoff_cap', config)
      let resolved = false
      void next.then(() => {
        resolved = true
      })
      await nextMicrotask()
      expect(resolved).toBe(false)
      await jest.runOnlyPendingTimersAsync()
      lease = await next
    }

    // Further failures are bounded at 5s instead of growing without limit.
    lease.releaseAfterLaunchFailure()
    const capped = acquireProfileLane('bybit_backoff_cap', config)
    let cappedResolved = false
    void capped.then(() => {
      cappedResolved = true
    })
    await jest.advanceTimersByTimeAsync(4_999)
    expect(cappedResolved).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    const recovered = await capped
    recovered.release()
  })

  it('keeps Tier A unsuffixed while serializing same-source sessions', async () => {
    const src = source('bybit_tier_a_mutex')
    const launched = contextMock()
    mockLaunchPersistentContext.mockResolvedValue(launched.context)

    const first = await openSession(src)
    await first.page()
    expect(mockLaunchPersistentContext).toHaveBeenCalledWith(
      expect.stringMatching(/profiles\/bybit_tier_a_mutex$/),
      expect.any(Object)
    )

    let secondResolved = false
    const secondPromise = openSession(src).then((session) => {
      secondResolved = true
      return session
    })
    await nextMicrotask()
    expect(secondResolved).toBe(false)

    await first.close()
    const second = await secondPromise
    expect(secondResolved).toBe(true)
    await second.close()
  })

  it('single-flights context creation and close waits for an in-flight launch', async () => {
    const launch = deferred<BrowserContext>()
    const launched = contextMock()
    mockLaunchPersistentContext.mockReturnValue(launch.promise)
    const session = await openSession(source('bybit_inflight_close'))

    const pagePromise = session.page()
    const apiPromise = session.api()
    const uses = Promise.allSettled([pagePromise, apiPromise])
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1)

    const firstClose = session.close()
    const secondClose = session.close()
    expect(secondClose).toBe(firstClose)
    await nextMicrotask()
    expect(launched.close).not.toHaveBeenCalled()

    launch.resolve(launched.context)
    const useResults = await uses
    expect(useResults).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('is closing') }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: expect.stringContaining('is closing') }),
      }),
    ])
    await firstClose
    expect(launched.close).toHaveBeenCalledTimes(1)
  })

  it('does not relaunch a local profile until reset closure is confirmed', async () => {
    const resetClose = deferred<void>()
    const resetStarted = deferred<void>()
    const firstContext = contextMock({
      close: () => {
        resetStarted.resolve(undefined)
        return resetClose.promise
      },
    })
    const secondContext = contextMock()
    ;(firstContext.page.evaluate as jest.Mock).mockRejectedValueOnce(new Error('Target closed'))
    ;(secondContext.page.evaluate as jest.Mock).mockResolvedValueOnce({
      status: 200,
      json: { ok: true },
    })
    mockLaunchPersistentContext
      .mockResolvedValueOnce(firstContext.context)
      .mockResolvedValueOnce(secondContext.context)

    const session = await openSession(source('bybit_reset_relaunch'))
    const fetch = session.pageFetch({
      url: 'https://example.test/profile',
      method: 'GET',
      headers: {},
    })
    await resetStarted.promise

    expect(firstContext.close).toHaveBeenCalledTimes(1)
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1)

    resetClose.resolve(undefined)
    await expect(fetch).resolves.toEqual({ status: 200, json: { ok: true } })
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2)
    await session.close()
  })

  it('serializes close behind reset and releases the lane only after confirmed closure', async () => {
    const resetClose = deferred<void>()
    const resetStarted = deferred<void>()
    const launched = contextMock({
      close: () => {
        resetStarted.resolve(undefined)
        return resetClose.promise
      },
    })
    ;(launched.page.evaluate as jest.Mock).mockRejectedValueOnce(new Error('Target closed'))
    mockLaunchPersistentContext.mockResolvedValueOnce(launched.context)
    const src = source('bybit_reset_close_race')
    const session = await openSession(src)

    const fetch = session.pageFetch({
      url: 'https://example.test/profile',
      method: 'GET',
      headers: {},
    })
    const fetchRejected = expect(fetch).rejects.toThrow('is closing')
    await resetStarted.promise
    expect(launched.close).toHaveBeenCalledTimes(1)
    const pageDuringReset = session.page()
    const pageRejected = expect(pageDuringReset).rejects.toThrow('is closing')

    let replacementResolved = false
    const replacementPromise = openSession(src).then((replacement) => {
      replacementResolved = true
      return replacement
    })
    const close = session.close()
    await nextMicrotask()
    expect(replacementResolved).toBe(false)

    resetClose.resolve(undefined)
    await fetchRejected
    await pageRejected
    await close
    const replacement = await replacementPromise
    expect(replacementResolved).toBe(true)
    await replacement.close()
  })

  it('quarantines the lane when reset cannot confirm context or browser closure', async () => {
    const launched = contextMock({
      browser: null,
      close: async () => {
        throw new Error('reset context close failed')
      },
    })
    ;(launched.page.evaluate as jest.Mock).mockRejectedValueOnce(new Error('Target closed'))
    mockLaunchPersistentContext.mockResolvedValueOnce(launched.context)
    const src = source('bybit_reset_quarantine')
    const session = await openSession(src)
    const waiter = openSession(src)
    const waiterRejected = expect(waiter).rejects.toThrow('has no healthy slots')

    await expect(
      session.pageFetch({
        url: 'https://example.test/profile',
        method: 'GET',
        headers: {},
      })
    ).rejects.toThrow('context close failed')
    await waiterRejected
    await expect(session.close()).rejects.toThrow('context close failed')
    expect(launched.close).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight state save before resetting the context', async () => {
    const stateSave = deferred<{ cookies: []; origins: [] }>()
    const firstContext = contextMock()
    const secondContext = contextMock()
    ;(firstContext.context.storageState as jest.Mock)
      .mockReturnValueOnce(stateSave.promise)
      .mockResolvedValue({ cookies: [], origins: [] })
    ;(firstContext.page.evaluate as jest.Mock).mockRejectedValueOnce(new Error('Target closed'))
    ;(secondContext.page.evaluate as jest.Mock).mockResolvedValueOnce({
      status: 200,
      json: { recovered: true },
    })
    mockLaunchPersistentContext
      .mockResolvedValueOnce(firstContext.context)
      .mockResolvedValueOnce(secondContext.context)

    const session = await openSession(source('bybit_save_reset_race'))
    await session.page()
    const save = session.saveState()
    const fetch = session.pageFetch({
      url: 'https://example.test/profile',
      method: 'GET',
      headers: {},
    })
    await nextMicrotask()
    expect(firstContext.close).not.toHaveBeenCalled()

    stateSave.resolve({ cookies: [], origins: [] })
    await save
    await expect(fetch).resolves.toEqual({ status: 200, json: { recovered: true } })
    expect(firstContext.close).toHaveBeenCalledTimes(1)
    await session.close()
  })

  it('waits for an in-flight state save before close releases the lane', async () => {
    const stateSave = deferred<{ cookies: []; origins: [] }>()
    const launched = contextMock()
    ;(launched.context.storageState as jest.Mock)
      .mockReturnValueOnce(stateSave.promise)
      .mockResolvedValue({ cookies: [], origins: [] })
    mockLaunchPersistentContext.mockResolvedValueOnce(launched.context)

    const session = await openSession(source('bybit_save_close_race'))
    await session.page()
    const save = session.saveState()
    const close = session.close()
    await nextMicrotask()
    expect(launched.close).not.toHaveBeenCalled()

    stateSave.resolve({ cookies: [], origins: [] })
    await save
    await close
    expect(launched.close).toHaveBeenCalledTimes(1)
  })

  it('rechecks api and capture state after their awaited context/page handoff', async () => {
    const apiContext = contextMock()
    mockLaunchPersistentContext.mockResolvedValueOnce(apiContext.context)
    const apiSession = await openSession(source('bybit_api_close_race'))
    await apiSession.page()
    const api = apiSession.api()
    const apiClose = apiSession.close()
    await expect(api).rejects.toThrow('is closing')
    await apiClose

    const captureContext = contextMock()
    mockLaunchPersistentContext.mockResolvedValueOnce(captureContext.context)
    const captureSession = await openSession(source('bybit_capture_close_race'))
    await captureSession.page()
    const capture = captureSession.capture(/profile/)
    const captureClose = captureSession.close()
    await expect(capture).rejects.toThrow('is closing')
    await captureClose
  })

  it('does not invoke a paced callback after close while the gate is waiting', async () => {
    jest.useFakeTimers()
    jest.spyOn(Math, 'random').mockReturnValue(0)
    const src = source('bybit_paced_close_race')
    src.rate_budget_ms = 1_000
    const session = await openSession(src)
    await session.paced(async () => 'first')

    const callback = jest.fn(async () => 'late')
    const queued = session.paced(callback)
    const queuedRejected = expect(queued).rejects.toThrow('is closed')
    await session.close()
    await jest.advanceTimersByTimeAsync(1_000)

    await queuedRejected
    expect(callback).not.toHaveBeenCalled()
  })

  it('rejects every browser entry point after close without relaunching', async () => {
    const session = await openSession(source('bybit_use_after_close'))
    await session.close()

    await expect(session.page()).rejects.toThrow('is closed')
    await expect(session.api()).rejects.toThrow('is closed')
    await expect(session.capture(/profile/)).rejects.toThrow('is closed')
    await expect(
      session.pageFetch({ url: 'https://example.test/profile', method: 'GET', headers: {} })
    ).rejects.toThrow('is closed')
    await expect(session.paced(async () => 'unexpected')).rejects.toThrow('is closed')
    expect(mockLaunchPersistentContext).not.toHaveBeenCalled()
  })

  it('uses browser.close as a confirmed fallback before releasing a local slot', async () => {
    const fallback = browserMock()
    const launched = contextMock({
      browser: fallback.browser,
      close: async () => {
        throw new Error('context close failed')
      },
    })
    mockLaunchPersistentContext.mockResolvedValue(launched.context)
    const src = source('bybit_close_fallback')
    const session = await openSession(src)
    await session.page()

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(session.close()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('browser fallback confirmed closure'))
    warn.mockRestore()
    expect(launched.close).toHaveBeenCalledTimes(1)
    expect(fallback.close).toHaveBeenCalledTimes(1)

    // The confirmed browser fallback returned the source-scoped default slot.
    const next = await openSession(src)
    await next.close()
  })

  it('quarantines a local slot when neither context nor browser closure is proven', async () => {
    const launched = contextMock({
      browser: null,
      close: async () => {
        throw new Error('context close failed')
      },
    })
    mockLaunchPersistentContext.mockResolvedValue(launched.context)
    const src = source('bybit_close_quarantine')
    const session = await openSession(src)
    await session.page()

    const replacement = openSession(src)
    const replacementRejected = expect(replacement).rejects.toThrow('has no healthy slots')
    await nextMicrotask()
    const closes = await Promise.allSettled([session.close(), session.close()])
    expect(closes.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(launched.close).toHaveBeenCalledTimes(1)
    await replacementRejected
    await expect(openSession(src)).rejects.toThrow('has no healthy slots')
  })

  it('rejects a waiter when both context and browser fallback close fail', async () => {
    const fallback = browserMock(async () => {
      throw new Error('browser close failed')
    })
    const launched = contextMock({
      browser: fallback.browser,
      close: async () => {
        throw new Error('context close failed')
      },
    })
    mockLaunchPersistentContext.mockResolvedValue(launched.context)
    const src = source('bybit_double_close_failure')
    const session = await openSession(src)
    await session.page()

    const waiter = openSession(src)
    const waiterRejected = expect(waiter).rejects.toThrow('has no healthy slots')
    await nextMicrotask()

    await expect(session.close()).rejects.toThrow('context and browser close both failed')
    expect(launched.close).toHaveBeenCalledTimes(1)
    expect(fallback.close).toHaveBeenCalledTimes(1)
    await waiterRejected
  })

  it('backs off a generic launch-failed slot and serves a waiter from the healthy slot', async () => {
    jest.useFakeTimers()
    const src = source('bybit_launch_rotation')
    mockLaunchPersistentContext.mockRejectedValueOnce(new Error('chrome launch failed'))

    const failed = await openSession(src, tierCOptions)
    await expect(failed.page()).rejects.toThrow('chrome launch failed')
    await expect(failed.close()).resolves.toBeUndefined()

    const secondContext = contextMock()
    mockLaunchPersistentContext.mockResolvedValueOnce(secondContext.context)
    const second = await openSession(src, tierCOptions)
    await second.page()
    expect(mockLaunchPersistentContext.mock.calls[0][0]).toMatch(/bybit_launch_rotation-tier-c-1$/)
    expect(mockLaunchPersistentContext.mock.calls[1][0]).toMatch(/bybit_launch_rotation-tier-c-2$/)

    let thirdResolved = false
    const thirdContext = contextMock()
    mockLaunchPersistentContext.mockResolvedValueOnce(thirdContext.context)
    const thirdPromise = openSession(src, tierCOptions).then((session) => {
      thirdResolved = true
      return session
    })
    await nextMicrotask()
    expect(thirdResolved).toBe(false)

    // Normal release of the healthy slot serves the existing waiter. The
    // failed slot remains cooling and is never handed over immediately.
    await second.close()
    const third = await thirdPromise
    await third.page()
    expect(mockLaunchPersistentContext.mock.calls[2][0]).toMatch(/bybit_launch_rotation-tier-c-2$/)

    await jest.runOnlyPendingTimersAsync()

    const fourthContext = contextMock()
    mockLaunchPersistentContext.mockResolvedValueOnce(fourthContext.context)
    const fourth = await openSession(src, tierCOptions)
    await fourth.page()
    expect(mockLaunchPersistentContext.mock.calls[3][0]).toMatch(/bybit_launch_rotation-tier-c-1$/)
    await Promise.all([third.close(), fourth.close()])
  })

  it('immediately quarantines ProcessSingleton failures instead of retrying the slot', async () => {
    const src = source('bybit_process_singleton')
    const session = await openSession(src)
    const waiter = openSession(src)
    const waiterRejected = expect(waiter).rejects.toThrow('has no healthy slots')
    mockLaunchPersistentContext.mockRejectedValueOnce(
      new Error('Failed to create a ProcessSingleton for your profile directory')
    )

    await expect(session.page()).rejects.toThrow('ProcessSingleton')
    await waiterRejected
    await expect(session.page()).rejects.toThrow('ProcessSingleton')
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1)
    await expect(session.close()).resolves.toBeUndefined()
    await expect(openSession(src)).rejects.toThrow('has no healthy slots')
  })

  it('does not queue remote contexts and isolates local lanes by source', async () => {
    const remote = source('bybit_remote', 'vps_jp')
    process.env.PLAYWRIGHT_WS_JP = 'ws://jp.test'
    const remoteBrowserOne = browserMock()
    const remoteBrowserTwo = browserMock()
    const remoteContextOne = contextMock({ browser: remoteBrowserOne.browser })
    const remoteContextTwo = contextMock({ browser: remoteBrowserTwo.browser })
    remoteBrowserOne.newContext.mockResolvedValue(remoteContextOne.context)
    remoteBrowserTwo.newContext.mockResolvedValue(remoteContextTwo.context)
    mockConnect
      .mockResolvedValueOnce(remoteBrowserOne.browser)
      .mockResolvedValueOnce(remoteBrowserTwo.browser)

    const [remoteOne, remoteTwo] = await Promise.all([openSession(remote), openSession(remote)])
    await Promise.all([remoteOne.page(), remoteTwo.page()])
    expect(mockConnect).toHaveBeenCalledTimes(2)
    await Promise.all([remoteOne.close(), remoteTwo.close()])
    expect(remoteContextOne.close).toHaveBeenCalledTimes(1)
    expect(remoteContextTwo.close).toHaveBeenCalledTimes(1)
    expect(remoteBrowserOne.close).toHaveBeenCalledTimes(1)
    expect(remoteBrowserTwo.close).toHaveBeenCalledTimes(1)

    const sourceOne = await openSession(source('bybit_source_one'))
    const sourceTwo = await openSession(source('bybit_source_two'))
    await Promise.all([sourceOne.close(), sourceTwo.close()])
  })

  it('rejects unsafe suffixes and duplicate physical-directory ownership', async () => {
    await expect(
      openSession(source('bybit_unsafe_suffix'), {
        profileLaneKey: 'tier-c',
        profileSuffix: '../escape',
      })
    ).rejects.toThrow('unsafe persistent-profile suffix')
    await expect(
      acquireProfileLane('bybit_too_many_slots', {
        laneKey: 'tier-c',
        profileSuffix: 'tier-c',
        slotCount: 17,
      })
    ).rejects.toThrow('integer from 1 to 16')

    const first = await acquireProfileLane('bybit_directory_owner', {
      laneKey: 'lane-one',
      profileSuffix: 'shared',
    })
    await expect(
      acquireProfileLane('bybit_directory_owner', {
        laneKey: 'lane-two',
        profileSuffix: 'shared',
      })
    ).rejects.toThrow('already owned by lane bybit_directory_owner/lane-one')
    first.release()

    const ambiguous = await acquireProfileLane('bybit_physical_name', {
      laneKey: 'lane-one',
      profileSuffix: 'shared',
    })
    await expect(
      acquireProfileLane('bybit_physical_name-shared', {
        laneKey: 'tier-a',
      })
    ).rejects.toThrow('already owned by lane bybit_physical_name/lane-one')
    ambiguous.release()
  })
})
