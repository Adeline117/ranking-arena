'use client'

import { act, renderHook, waitFor } from '@testing-library/react'

const mockGetCsrfHeaders = jest.fn(() => ({ 'X-CSRF-Token': 'csrf-token' }))

type MockAuthSession = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

let mockAuth: MockAuthSession
const mockUseAuthSession = jest.fn(() => mockAuth)

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => mockGetCsrfHeaders(),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  __esModule: true,
  useAuthSession: () => mockUseAuthSession(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import { useAlertConfig } from '../useAlertConfig'

const mockFetch = jest.fn()
let getQueue: Array<Response | Promise<Response>>
let postQueue: Array<Response | Promise<Response>>

function authFor(userId: string, sessionGeneration: number, accessToken = `token-${userId}`) {
  return {
    accessToken,
    authChecked: true,
    email: `${userId}@example.com`,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function anonymousAuth(sessionGeneration: number): MockAuthSession {
  return {
    accessToken: null,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration,
    userId: null,
    viewerKey: 'anon',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function configResponse(value: string): Response {
  return response({
    ok: true,
    config: {
      slack_webhook_url: {
        value,
        enabled: true,
      },
    },
  })
}

describe('useAlertConfig request scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getQueue = []
    postQueue = []
    mockFetch.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      const queue = (init?.method ?? 'GET') === 'POST' ? postQueue : getQueue
      const next = queue.shift()
      if (!next) throw new Error(`Unexpected ${init?.method ?? 'GET'} request`)
      return Promise.resolve(next)
    })
    global.fetch = mockFetch
    mockAuth = authFor('admin-a', 1, 'token-a')
  })

  function queueGet(...responses: Array<Response | Promise<Response>>) {
    getQueue.push(...responses)
  }

  function queuePost(...responses: Array<Response | Promise<Response>>) {
    postQueue.push(...responses)
  }

  it('single-flights duplicate saves for the same config key within one scope', async () => {
    const saveResponse = deferred<Response>()
    queuePost(saveResponse.promise)
    const showToast = jest.fn()
    const hook = renderHook(
      ({ token }: { token: string | null }) => useAlertConfig(token, showToast),
      {
        initialProps: { token: 'token-a' },
      }
    )

    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = hook.result.current.updateConfig('slack_webhook_url', 'https://first', true)
      second = hook.result.current.updateConfig('slack_webhook_url', 'https://second', true)
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(hook.result.current.saving).toBe(true)
    expect(JSON.parse(String(mockFetch.mock.calls[0][1]?.body))).toEqual({
      key: 'slack_webhook_url',
      value: 'https://first',
      enabled: true,
    })

    await act(async () => {
      saveResponse.resolve(response({ ok: true }))
      await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    })

    await waitFor(() => expect(hook.result.current.saving).toBe(false))
    expect(hook.result.current.config.slack_webhook_url).toEqual({
      value: 'https://first',
      enabled: true,
    })
    expect(showToast).not.toHaveBeenCalled()
  })

  it('does not reuse same-key saves across viewer scopes and ignores stale acknowledgements', async () => {
    const saveA = deferred<Response>()
    const saveB = deferred<Response>()
    queuePost(saveA.promise, saveB.promise)
    const showToast = jest.fn()
    const hook = renderHook(
      ({ token }: { token: string | null }) => useAlertConfig(token, showToast),
      {
        initialProps: { token: 'token-a' },
      }
    )

    let first!: Promise<boolean>
    act(() => {
      first = hook.result.current.updateConfig('slack_webhook_url', 'https://scope-a', true)
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(mockFetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer token-a',
    })

    mockAuth = authFor('admin-b', 2, 'token-b')
    hook.rerender({ token: 'token-b' })

    let second!: Promise<boolean>
    act(() => {
      second = hook.result.current.updateConfig('slack_webhook_url', 'https://scope-b', true)
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: 'Bearer token-b',
    })

    await act(async () => {
      saveA.resolve(response({ ok: true }))
      await expect(first).resolves.toBe(false)
    })

    expect(hook.result.current.config).toEqual({})

    await act(async () => {
      saveB.resolve(response({ ok: true }))
      await expect(second).resolves.toBe(true)
    })

    await waitFor(() =>
      expect(hook.result.current.config.slack_webhook_url).toEqual({
        value: 'https://scope-b',
        enabled: true,
      })
    )
    expect(showToast).not.toHaveBeenCalled()
  })

  it('drops stale loads from the previous scope and clears on logout', async () => {
    const loadA = deferred<Response>()
    const loadB = deferred<Response>()
    queueGet(loadA.promise, loadB.promise)

    const hook = renderHook(({ token }: { token: string | null }) => useAlertConfig(token), {
      initialProps: { token: 'token-a' },
    })

    await act(async () => {
      void hook.result.current.loadConfig()
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockAuth = authFor('admin-b', 2, 'token-b')
    hook.rerender({ token: 'token-b' })

    await act(async () => {
      void hook.result.current.loadConfig()
    })

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      loadB.resolve(configResponse('https://scope-b'))
      await loadB.promise
    })

    await waitFor(() =>
      expect(hook.result.current.config.slack_webhook_url).toEqual({
        value: 'https://scope-b',
        enabled: true,
      })
    )

    await act(async () => {
      loadA.resolve(configResponse('https://scope-a'))
      await loadA.promise
    })

    expect(hook.result.current.config.slack_webhook_url).toEqual({
      value: 'https://scope-b',
      enabled: true,
    })

    mockAuth = anonymousAuth(3)
    hook.rerender({ token: null })

    expect(hook.result.current.config).toEqual({})
    expect(hook.result.current.loading).toBe(false)
    expect(hook.result.current.saving).toBe(false)
    expect(hook.result.current.error).toBeNull()
  })
})
