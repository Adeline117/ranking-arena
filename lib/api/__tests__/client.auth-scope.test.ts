jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    forceRefresh: jest.fn(),
  },
}))

import { apiRequest, authedFetch } from '../client'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockForceRefresh = tokenRefreshCoordinator.forceRefresh as jest.Mock

function response(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(data),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

describe('authedFetch viewer-bound retry', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    mockForceRefresh.mockReset()
    global.fetch = jest.fn()
  })

  it('never replays an A request with a token obtained after switching to B', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(401, { error: 'expired' }))
    let resolveRefresh!: (token: string) => void
    mockForceRefresh.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRefresh = resolve
      })
    )

    const request = authedFetch('/api/private', 'POST', jwt('user-a'), {}, 15_000, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })
    await Promise.resolve()
    beginViewerTransition('user-b')
    resolveRefresh(jwt('user-b'))

    await expect(request).resolves.toMatchObject({ stale: true, ok: false })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries once after a same-user token refresh', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockResolvedValueOnce(response(200, { success: true }))
    const tokenA1 = jwt('user-a')
    const tokenA2 = `${jwt('user-a')}.refreshed`
    mockForceRefresh.mockResolvedValueOnce(tokenA2)

    const result = await authedFetch('/api/private', 'GET', tokenA1, undefined, 15_000, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.stale).toBeUndefined()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect((global.fetch as jest.Mock).mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${tokenA2}`
    )
  })

  it('rejects an explicit scope whose access-token subject belongs to another user', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')

    const result = await authedFetch('/api/private', 'POST', jwt('user-b'), {}, 15_000, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })

    expect(result).toMatchObject({ ok: false, stale: true, status: 0 })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('apiRequest discards an A response that resolves after switching to B', async () => {
    synchronizeViewerScope(true, 'user-a')
    const initial = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(initial.promise)

    const request = apiRequest('/api/private')
    beginViewerTransition('user-b')
    initial.resolve(response(200, { secret: 'A' }))

    await expect(request).resolves.toMatchObject({
      success: false,
      error: { code: 'STALE_AUTH_SCOPE' },
    })
  })

  it('apiRequest discards an anonymous cookie response after login begins', async () => {
    synchronizeViewerScope(true, null)
    const initial = deferred<Response>()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(initial.promise)

    const request = apiRequest('/api/personalized-public-feed')
    beginViewerTransition('user-b')
    initial.resolve(response(200, { viewer: 'anonymous' }))

    await expect(request).resolves.toMatchObject({
      success: false,
      error: { code: 'STALE_AUTH_SCOPE' },
    })
  })

  it('apiRequest does not send while initial auth restoration is pending', async () => {
    const result = await apiRequest('/api/personalized-public-feed')

    expect(result).toMatchObject({ success: false, error: { code: 'AUTH_PENDING' } })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('apiRequest never sends an A mutation header in the current B scope', async () => {
    synchronizeViewerScope(true, 'user-b')

    const result = await apiRequest('/api/private', {
      method: 'POST',
      body: { value: 'A-only' },
      headers: { Authorization: `Bearer ${jwt('user-a')}` },
    })

    expect(result).toMatchObject({
      success: false,
      error: { code: 'STALE_AUTH_SCOPE' },
    })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockForceRefresh).not.toHaveBeenCalled()
  })

  it('apiRequest rechecks viewer scope after retry backoff before sending', async () => {
    jest.useFakeTimers()
    try {
      synchronizeViewerScope(true, 'user-a')
      ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(503, { error: 'retry' }))

      const request = apiRequest('/api/private', { retries: 1, retryBaseDelayMs: 100 })
      while ((global.fetch as jest.Mock).mock.calls.length < 1) await Promise.resolve()
      await Promise.resolve()
      beginViewerTransition('user-b')
      await jest.advanceTimersByTimeAsync(100)

      await expect(request).resolves.toMatchObject({
        success: false,
        error: { code: 'STALE_AUTH_SCOPE' },
      })
      expect(global.fetch).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('apiRequest checks scope after refresh and does not retry A as B', async () => {
    synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(401, { error: 'expired' }))
    mockForceRefresh.mockImplementationOnce(async () => {
      beginViewerTransition('user-b')
      return 'token-b'
    })

    const result = await apiRequest('/api/private')

    expect(result).toMatchObject({ success: false, error: { code: 'STALE_AUTH_SCOPE' } })
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('apiRequest checks scope after retry parsing when logout happens in flight', async () => {
    synchronizeViewerScope(true, 'user-a')
    const retry = deferred<Response>()
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockReturnValueOnce(retry.promise)
    mockForceRefresh.mockResolvedValueOnce('token-a2')

    const request = apiRequest('/api/private')
    while ((global.fetch as jest.Mock).mock.calls.length < 2) await Promise.resolve()
    beginViewerTransition(null)
    retry.resolve(response(200, { secret: 'A' }))

    await expect(request).resolves.toMatchObject({
      success: false,
      error: { code: 'STALE_AUTH_SCOPE' },
    })
  })
})
