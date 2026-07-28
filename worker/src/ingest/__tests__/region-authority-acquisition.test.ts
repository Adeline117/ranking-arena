/** @jest-environment node */

import {
  acquireRegionAuthorityLifecycleWithRetry,
  REGION_AUTHORITY_ACQUISITION_CONTENTION_DEADLINE_MS,
  REGION_AUTHORITY_ACQUISITION_PARK_KEEPALIVE_MS,
  REGION_AUTHORITY_ACQUISITION_RETRY_MS,
  type AcquireRegionAuthorityLifecycleWithRetryOptions,
} from '../region-authority-acquisition'
import type {
  AcquireRegionAuthorityLifecycleResult,
  RegionAuthorityLifecycle,
} from '../region-authority-lifecycle'
import type { WorkerOwnershipHeartbeatInput } from '../worker-instance-ownership'

function heartbeat(): WorkerOwnershipHeartbeatInput {
  return {
    attempt_bound_capture: true,
    node: 'authority-acquisition-test',
    pid: 42,
    regions: ['local'],
    release_id: 'a'.repeat(64),
    sha: 'b'.repeat(40),
  }
}

function activeLifecycle() {
  const stopAfterDrain = jest.fn(async (drain: () => Promise<void>) => drain())
  const lifecycle = {
    failure: undefined,
    fence: {} as RegionAuthorityLifecycle['fence'],
    region: 'local' as const,
    state: 'active' as const,
    stopAfterDrain,
  }
  return { lifecycle, stopAfterDrain }
}

function contended(): AcquireRegionAuthorityLifecycleResult {
  return {
    authorityScope: 'region:local',
    observedControlEpoch: 7,
    observedControlServerTimeMs: 9_000,
    region: 'local',
    status: 'contended',
  }
}

function options(
  acquireLifecycle: NonNullable<
    AcquireRegionAuthorityLifecycleWithRetryOptions['acquireLifecycle']
  >,
  signal = new AbortController().signal,
  overrides: Partial<AcquireRegionAuthorityLifecycleWithRetryOptions> = {}
): AcquireRegionAuthorityLifecycleWithRetryOptions {
  return {
    acquireLifecycle,
    heartbeat,
    onLost: jest.fn(),
    redis: { eval: jest.fn() },
    region: 'local',
    signal,
    ...overrides,
  }
}

async function flushAcquisition(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('region authority acquisition contention retry', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('uses a default window that covers process kill, lease expiry and jitter', () => {
    expect(REGION_AUTHORITY_ACQUISITION_RETRY_MS).toBeGreaterThanOrEqual(2_000)
    expect(REGION_AUTHORITY_ACQUISITION_RETRY_MS).toBeLessThanOrEqual(5_000)
    expect(REGION_AUTHORITY_ACQUISITION_CONTENTION_DEADLINE_MS).toBeGreaterThan(30_000 + 180_000)
  })

  it('returns the first active lifecycle immediately without scheduling a retry', async () => {
    jest.useFakeTimers()
    const active = activeLifecycle()
    const acquireLifecycle = jest.fn(async () => ({
      lifecycle: active.lifecycle,
      status: 'active' as const,
    }))

    await expect(acquireRegionAuthorityLifecycleWithRetry(options(acquireLifecycle))).resolves.toBe(
      active.lifecycle
    )
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(active.stopAfterDrain).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('retries only contention in the same process and returns the later lifecycle', async () => {
    jest.useFakeTimers()
    const active = activeLifecycle()
    const acquireLifecycle = jest
      .fn<Promise<AcquireRegionAuthorityLifecycleResult>, []>()
      .mockResolvedValueOnce(contended())
      .mockResolvedValueOnce({ lifecycle: active.lifecycle, status: 'active' })
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, undefined, {
        contentionDeadlineMs: 20_000,
        retryAfterMs: 3_000,
      })
    )

    await flushAcquisition()
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(2_999)
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)

    await expect(acquisition).resolves.toBe(active.lifecycle)
    expect(acquireLifecycle).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('parks continuous contention with one PID keepalive until abort', async () => {
    jest.useFakeTimers()
    const setIntervalSpy = jest.spyOn(global, 'setInterval')
    const controller = new AbortController()
    const log = jest.fn()
    const acquireLifecycle = jest.fn(async () => contended())
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, {
        contentionDeadlineMs: 10_000,
        log,
        retryAfterMs: 3_000,
      })
    )
    const rejection = expect(acquisition).rejects.toMatchObject({
      code: 'aborted',
      region: 'local',
    })
    const settled = jest.fn()
    void acquisition.then(settled, settled)

    await flushAcquisition()
    await jest.advanceTimersByTimeAsync(10_000)
    await flushAcquisition()
    expect(acquireLifecycle).toHaveBeenCalledTimes(4)
    expect(log).toHaveBeenLastCalledWith(
      '[ingest-worker] local authority acquisition parked after contention deadline'
    )
    expect(settled).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)
    const parkKeepalive = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout | undefined
    expect(parkKeepalive?.hasRef()).toBe(true)

    await jest.advanceTimersByTimeAsync(REGION_AUTHORITY_ACQUISITION_PARK_KEEPALIVE_MS * 3)
    expect(acquireLifecycle).toHaveBeenCalledTimes(4)
    expect(settled).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)

    controller.abort(new Error('deployment cancelled with private reason'))
    await rejection
    expect(settled).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('fails closed before the first acquire when already aborted', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    controller.abort(new Error('rediss://private-owner-token'))
    const acquireLifecycle = jest.fn()

    await expect(
      acquireRegionAuthorityLifecycleWithRetry(options(acquireLifecycle, controller.signal))
    ).rejects.toMatchObject({
      code: 'aborted',
      message: '[ingest-worker] local authority acquisition failed (aborted)',
      region: 'local',
    })
    expect(acquireLifecycle).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not start the deferred first acquire after a same-stack abort', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const acquireLifecycle = jest.fn(async () => contended())
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal)
    )
    const rejection = expect(acquisition).rejects.toMatchObject({
      code: 'aborted',
      region: 'local',
    })

    controller.abort(new Error('same-stack private abort reason'))

    await rejection
    expect(acquireLifecycle).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('aborts a contention wait immediately and cancels its retry timer', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const acquireLifecycle = jest.fn(async () => contended())
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, {
        contentionDeadlineMs: 20_000,
        retryAfterMs: 3_000,
      })
    )

    await flushAcquisition()
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    controller.abort(new Error('postgres://private-password'))

    await expect(acquisition).rejects.toMatchObject({ code: 'aborted', region: 'local' })
    await jest.advanceTimersByTimeAsync(20_000)
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('observes an in-flight acquire after abort and releases a late active lifecycle', async () => {
    jest.useFakeTimers()
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout')
    const controller = new AbortController()
    const active = activeLifecycle()
    let resolveAcquire!: (result: AcquireRegionAuthorityLifecycleResult) => void
    const acquireLifecycle = jest.fn(
      () =>
        new Promise<AcquireRegionAuthorityLifecycleResult>((resolve) => {
          resolveAcquire = resolve
        })
    )
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, { contentionDeadlineMs: 20_000 })
    )
    const rejection = expect(acquisition).rejects.toMatchObject({
      code: 'aborted',
      region: 'local',
    })
    const settled = jest.fn()
    void acquisition.then(settled, settled)

    await flushAcquisition()
    const deadlineTimer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout | undefined
    expect(deadlineTimer?.hasRef()).toBe(true)
    controller.abort(new Error('private abort reason'))
    await flushAcquisition()
    expect(settled).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)

    resolveAcquire({ lifecycle: active.lifecycle, status: 'active' })
    await rejection
    expect(active.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(active.stopAfterDrain.mock.calls[0]).toHaveLength(1)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('parks an in-flight acquire at the deadline and releases a late active result', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    const active = activeLifecycle()
    let resolveAcquire!: (result: AcquireRegionAuthorityLifecycleResult) => void
    const acquireLifecycle = jest.fn(
      () =>
        new Promise<AcquireRegionAuthorityLifecycleResult>((resolve) => {
          resolveAcquire = resolve
        })
    )
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, { contentionDeadlineMs: 10_000 })
    )
    const rejection = expect(acquisition).rejects.toMatchObject({
      code: 'aborted',
      region: 'local',
    })
    const settled = jest.fn()
    void acquisition.then(settled, settled)

    await flushAcquisition()
    await jest.advanceTimersByTimeAsync(10_000)
    await flushAcquisition()
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)

    controller.abort(new Error('deployment cancelled'))
    await flushAcquisition()
    expect(active.stopAfterDrain).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(1)

    resolveAcquire({ lifecycle: active.lifecycle, status: 'active' })
    await rejection
    expect(active.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('never overlaps acquire attempts while the first attempt is unresolved', async () => {
    jest.useFakeTimers()
    const controller = new AbortController()
    let resolveAcquire!: (result: AcquireRegionAuthorityLifecycleResult) => void
    let concurrent = 0
    let maxConcurrent = 0
    const acquireLifecycle = jest.fn(() => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      return new Promise<AcquireRegionAuthorityLifecycleResult>((resolve) => {
        resolveAcquire = resolve
      }).finally(() => {
        concurrent -= 1
      })
    })
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, {
        contentionDeadlineMs: 50_000,
        retryAfterMs: 2_000,
      })
    )
    const rejection = expect(acquisition).rejects.toMatchObject({ code: 'aborted' })

    await flushAcquisition()
    await jest.advanceTimersByTimeAsync(20_000)
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(concurrent).toBe(1)
    expect(maxConcurrent).toBe(1)

    controller.abort(new Error('stop unresolved acquisition'))
    await flushAcquisition()
    expect(concurrent).toBe(1)
    resolveAcquire(contended())
    await rejection
    expect(concurrent).toBe(0)
    expect(maxConcurrent).toBe(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('logs only a fixed message when late active cleanup rejects', async () => {
    jest.useFakeTimers()
    const secret = 'postgres://late-cleanup:private@example.invalid'
    const controller = new AbortController()
    const log = jest.fn()
    const active = activeLifecycle()
    active.stopAfterDrain.mockRejectedValueOnce(new Error(secret))
    let resolveAcquire!: (result: AcquireRegionAuthorityLifecycleResult) => void
    const acquireLifecycle = jest.fn(
      () =>
        new Promise<AcquireRegionAuthorityLifecycleResult>((resolve) => {
          resolveAcquire = resolve
        })
    )
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, controller.signal, { log })
    )
    const rejection = expect(acquisition).rejects.toMatchObject({ code: 'aborted' })

    await flushAcquisition()
    controller.abort(new Error('abort reason with another private value'))
    resolveAcquire({ lifecycle: active.lifecycle, status: 'active' })
    await rejection

    expect(active.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(
      '[ingest-worker] local late authority acquisition cleanup failed'
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not retry or expose a synchronous acquisition throw', async () => {
    jest.useFakeTimers()
    const secret = 'rediss://operator:secret@example.invalid'
    const log = jest.fn()
    const acquireLifecycle = jest.fn(() => {
      throw new Error(secret)
    })

    await expect(
      acquireRegionAuthorityLifecycleWithRetry(options(acquireLifecycle, undefined, { log }))
    ).rejects.toMatchObject({
      code: 'acquire_failed',
      message: '[ingest-worker] local authority acquisition failed (acquire_failed)',
    })
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[ingest-worker] local authority acquisition failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not retry or expose a rejected non-contention failure', async () => {
    jest.useFakeTimers()
    const secret = 'postgres://operator:secret@example.invalid'
    const acquireLifecycle = jest.fn(async () => {
      throw new Error(secret)
    })

    await expect(
      acquireRegionAuthorityLifecycleWithRetry(options(acquireLifecycle))
    ).rejects.toMatchObject({
      code: 'acquire_failed',
      message: expect.not.stringContaining(secret),
      region: 'local',
    })
    expect(acquireLifecycle).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('observes rejected asynchronous loggers without changing admission', async () => {
    jest.useFakeTimers()
    const active = activeLifecycle()
    const log = jest.fn(async () => {
      throw new Error('logging transport secret')
    })
    const acquireLifecycle = jest
      .fn<Promise<AcquireRegionAuthorityLifecycleResult>, []>()
      .mockResolvedValueOnce(contended())
      .mockResolvedValueOnce({ lifecycle: active.lifecycle, status: 'active' })
    const acquisition = acquireRegionAuthorityLifecycleWithRetry(
      options(acquireLifecycle, undefined, {
        contentionDeadlineMs: 20_000,
        log,
        retryAfterMs: 2_000,
      })
    )

    await flushAcquisition()
    await jest.advanceTimersByTimeAsync(2_000)
    await expect(acquisition).resolves.toBe(active.lifecycle)
    await flushAcquisition()
    expect(log).toHaveBeenCalledWith('[ingest-worker] local authority is contended; retrying')
    expect(jest.getTimerCount()).toBe(0)
  })
})
