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

function responseWithJson(status: number, json: () => Promise<unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(json),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

describe('authedFetch viewer-bound retry', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    mockForceRefresh.mockReset()
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.useRealTimers()
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

  it('keeps the deadline when a caller also supplies an unmount signal', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const unmountController = new AbortController()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(new Promise<Response>(() => {}))

    const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: unmountController.signal,
    })
    await Promise.resolve()
    const transportSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal

    expect(transportSignal).not.toBe(unmountController.signal)
    expect(transportSignal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(1)
    await jest.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
    expect(transportSignal.aborted).toBe(true)
    expect(unmountController.signal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('uses the same bounded deadline for the 401 retry transport', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const unmountController = new AbortController()
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(401, { error: 'expired' }))
      .mockReturnValueOnce(new Promise<Response>(() => {}))
    mockForceRefresh.mockResolvedValueOnce(`${jwt('user-a')}.refreshed`)

    const request = authedFetch('/api/private', 'POST', jwt('user-a'), {}, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: unmountController.signal,
    })
    while ((global.fetch as jest.Mock).mock.calls.length < 2) await Promise.resolve()
    const firstSignal = (global.fetch as jest.Mock).mock.calls[0][1].signal as AbortSignal
    const retrySignal = (global.fetch as jest.Mock).mock.calls[1][1].signal as AbortSignal

    expect(retrySignal).toBe(firstSignal)
    expect(jest.getTimerCount()).toBe(1)
    await jest.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('does not start transport for a caller signal that is already aborted', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const callerController = new AbortController()
    callerController.abort()

    const result = await authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: callerController.signal,
    })

    expect(result).toEqual({ ok: false, status: 0, data: null })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('consumes a transport rejection when caller abort wins during fetch creation', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const callerController = new AbortController()
    ;(global.fetch as jest.Mock).mockImplementationOnce(() => {
      callerController.abort()
      return Promise.reject(new DOMException('transport aborted', 'AbortError'))
    })

    const result = await authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: callerController.signal,
    })
    await Promise.resolve()

    expect(result).toEqual({ ok: false, status: 0, data: null })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('cancels a never-resolving transport when the caller aborts', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const callerController = new AbortController()
    ;(global.fetch as jest.Mock).mockReturnValueOnce(new Promise<Response>(() => {}))

    const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: callerController.signal,
    })
    await Promise.resolve()
    callerController.abort()

    await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('works when iOS 15 has neither AbortSignal.timeout nor AbortSignal.any', async () => {
    jest.useFakeTimers()
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any')
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
    try {
      const scope = synchronizeViewerScope(true, 'user-a')
      const callerController = new AbortController()
      ;(global.fetch as jest.Mock).mockReturnValueOnce(new Promise<Response>(() => {}))

      const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
        expectedUserId: 'user-a',
        expectedSessionGeneration: scope.sessionGeneration,
        signal: callerController.signal,
      })
      await jest.advanceTimersByTimeAsync(100)

      await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
      if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor)
    }
  })

  it('cleans its timer and caller listener immediately after a successful request', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const callerController = new AbortController()
    const removeListener = jest.spyOn(callerController.signal, 'removeEventListener')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(200, { success: true }))

    const result = await authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: callerController.signal,
    })

    expect(result).toMatchObject({ ok: true })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(jest.getTimerCount()).toBe(0)
  })

  it('cleans its timer and caller listener when transport fails', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const callerController = new AbortController()
    const removeListener = jest.spyOn(callerController.signal, 'removeEventListener')
    ;(global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network failed'))

    const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
      signal: callerController.signal,
    })

    await expect(request).rejects.toThrow('network failed')
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(jest.getTimerCount()).toBe(0)
  })

  it('bounds a never-resolving token refresh with the original deadline', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(response(401, { error: 'expired' }))
    mockForceRefresh.mockReturnValueOnce(new Promise<string | null>(() => {}))

    const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })
    while (mockForceRefresh.mock.calls.length < 1) await Promise.resolve()
    await jest.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('bounds never-resolving response JSON parsing with the original deadline', async () => {
    jest.useFakeTimers()
    const scope = synchronizeViewerScope(true, 'user-a')
    const responseValue = responseWithJson(200, () => new Promise<unknown>(() => {}))
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(responseValue)

    const request = authedFetch('/api/private', 'GET', jwt('user-a'), undefined, 100, {
      expectedUserId: 'user-a',
      expectedSessionGeneration: scope.sessionGeneration,
    })
    while ((responseValue.json as jest.Mock).mock.calls.length < 1) await Promise.resolve()
    await jest.advanceTimersByTimeAsync(100)

    await expect(request).resolves.toEqual({ ok: false, status: 0, data: null })
    expect(jest.getTimerCount()).toBe(0)
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
