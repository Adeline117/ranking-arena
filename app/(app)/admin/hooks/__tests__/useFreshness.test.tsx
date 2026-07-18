import { act, renderHook, waitFor } from '@testing-library/react'
import { useFreshness } from '../useFreshness'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import type { FreshnessReport } from '@/lib/rankings/freshness-report'

const mockAuthedFetch = jest.fn()

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'

function token(subject: string, marker = 'token'): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function validReport(): FreshnessReport {
  return {
    ok: false,
    checked_at: '2026-07-18T18:00:00.000Z',
    summary: { total: 1, fresh: 0, stale: 0, critical: 0, unknown: 1 },
    thresholds: { stale_hours: 8, critical_hours: 24 },
    platforms: [
      {
        platform: 'gmx',
        displayName: 'GMX',
        lastUpdate: null,
        ageMs: null,
        ageHours: null,
        status: 'unknown',
        recordCount: 0,
      },
    ],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

describe('useFreshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
  })

  it('does not request or expose another slot without an access token', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: validReport() })
    const hook = renderHook(({ accessToken }) => useFreshness(accessToken), {
      initialProps: { accessToken: token(ACTOR_A) as string | null },
    })

    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(true)
    })
    expect(hook.result.current.freshnessReport).toEqual(validReport())

    act(() => {
      synchronizeViewerScope(true, null)
      hook.rerender({ accessToken: null })
    })
    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(false)
    })

    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(hook.result.current.freshnessReport).toBeNull()
    expect(hook.result.current.error).toBeNull()
  })

  it('uses the admin endpoint with the exact viewer-bound bearer token', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const accessToken = token(ACTOR_A)
    mockAuthedFetch.mockResolvedValue({ ok: true, status: 200, data: validReport() })
    const hook = renderHook(() => useFreshness(accessToken))

    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(true)
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/admin/data-freshness',
      'GET',
      accessToken,
      undefined,
      15_000,
      expect.objectContaining({ expectedUserId: ACTOR_A })
    )
    expect(hook.result.current.freshnessReport).toEqual(validReport())
    expect(hook.result.current.error).toBeNull()
  })

  it('surfaces a 401 instead of treating its body as an empty report', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: 'unauthorized' },
    })
    const hook = renderHook(() => useFreshness(token(ACTOR_A)))

    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(false)
    })

    expect(hook.result.current.freshnessReport).toBeNull()
    expect(hook.result.current.error).toEqual({ kind: 'unauthorized', status: 401 })
  })

  it('keeps the last verified report when a refresh fails', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, data: validReport() })
      .mockResolvedValueOnce({ ok: false, status: 500, data: null })
    const hook = renderHook(() => useFreshness(token(ACTOR_A)))

    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(true)
      expect(await hook.result.current.loadFreshnessReport()).toBe(false)
    })

    expect(hook.result.current.freshnessReport).toEqual(validReport())
    expect(hook.result.current.error).toEqual({ kind: 'server', status: 500 })
  })

  it('rejects a successful HTTP response whose report contract drifted', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        ...validReport(),
        thresholds: { stale: '8h', critical: '24h' },
      },
    })
    const hook = renderHook(() => useFreshness(token(ACTOR_A)))

    await act(async () => {
      expect(await hook.result.current.loadFreshnessReport()).toBe(false)
    })

    expect(hook.result.current.freshnessReport).toBeNull()
    expect(hook.result.current.error).toEqual({ kind: 'invalid_response', status: 200 })
  })

  it('ignores a late response after the viewer changes', async () => {
    synchronizeViewerScope(true, ACTOR_A)
    const response = deferred<{
      ok: boolean
      status: number
      data: FreshnessReport
    }>()
    mockAuthedFetch.mockReturnValue(response.promise)
    const hook = renderHook(({ accessToken }) => useFreshness(accessToken), {
      initialProps: { accessToken: token(ACTOR_A) },
    })

    let pending!: Promise<boolean>
    act(() => {
      pending = hook.result.current.loadFreshnessReport()
    })
    await waitFor(() => expect(hook.result.current.loading).toBe(true))

    act(() => {
      synchronizeViewerScope(true, ACTOR_B)
      hook.rerender({ accessToken: token(ACTOR_B) })
    })
    expect(hook.result.current.freshnessReport).toBeNull()

    await act(async () => {
      response.resolve({ ok: true, status: 200, data: validReport() })
      await expect(pending).resolves.toBe(false)
    })

    expect(hook.result.current.freshnessReport).toBeNull()
    expect(hook.result.current.error).toBeNull()
  })
})
