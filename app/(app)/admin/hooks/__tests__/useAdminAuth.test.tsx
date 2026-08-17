import { act, renderHook, waitFor } from '@testing-library/react'

const mockAuthedFetch = jest.fn()
const mockGetToken = jest.fn()
const mockReplace = jest.fn()
const mockToast = jest.fn()
const mockRouter = { replace: mockReplace }

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'pending' | 'anon' | `user:${string}`
}

const ADMIN_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: `${userId}@example.test`,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(ADMIN_A, 'token-a', 1)

jest.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => mockRouter,
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ ...mockAuth, getToken: mockGetToken }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/hooks/useApiMutation', () => ({
  getGlobalToast: () => mockToast,
}))

jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import { useAdminAuth } from '../useAdminAuth'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function acknowledgement(userId: string, email = 'admin@example.test') {
  return {
    success: true,
    data: { admin: { email, id: userId } },
    meta: { timestamp: '2026-08-17T00:00:00.000Z' },
  }
}

function result(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

describe('useAdminAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthedFetch.mockReset()
    mockGetToken.mockReset()
    mockAuth = signedIn(ADMIN_A, 'token-a', 1)
    mockGetToken.mockImplementation(() => Promise.resolve(mockAuth.accessToken))
  })

  it('publishes the current bearer only after a server-bound admin acknowledgement', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockReturnValue(pending.promise)

    const { result: hook } = renderHook(() => useAdminAuth())

    expect(hook.current).toMatchObject({
      accessToken: null,
      authChecking: true,
      isAdmin: false,
      userId: null,
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/admin/authority',
      'GET',
      'token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: ADMIN_A,
        signal: expect.any(AbortSignal),
      })
    )

    await act(async () => pending.resolve(result(acknowledgement(ADMIN_A))))

    await waitFor(() => expect(hook.current.isAdmin).toBe(true))
    expect(hook.current).toMatchObject({
      accessToken: 'token-a',
      authChecking: false,
      email: `${ADMIN_A}@example.test`,
      userId: ADMIN_A,
    })
  })

  it('masks an old admin synchronously and drops its late acknowledgement after an account switch', async () => {
    const adminRequest = deferred<ReturnType<typeof result>>()
    const nextViewerRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockImplementation((_url: string, _method: string, token: string) =>
      token === 'token-a' ? adminRequest.promise : nextViewerRequest.promise
    )

    const view = renderHook(() => useAdminAuth())
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    mockAuth = signedIn(USER_B, 'token-b', 2)
    view.rerender()

    expect(view.result.current).toMatchObject({
      accessToken: null,
      authChecking: true,
      isAdmin: false,
      userId: null,
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => adminRequest.resolve(result(acknowledgement(ADMIN_A))))

    expect(view.result.current.isAdmin).toBe(false)
    expect(view.result.current.accessToken).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('re-verifies a refreshed token and never exposes the new bearer under the old proof', async () => {
    mockAuthedFetch.mockResolvedValueOnce(result(acknowledgement(ADMIN_A)))
    const refreshedRequest = deferred<ReturnType<typeof result>>()
    mockAuthedFetch.mockReturnValueOnce(refreshedRequest.promise)

    const view = renderHook(() => useAdminAuth())
    await waitFor(() => expect(view.result.current.isAdmin).toBe(true))

    mockAuth = signedIn(ADMIN_A, 'token-a-refreshed', 1)
    view.rerender()

    expect(view.result.current).toMatchObject({
      accessToken: null,
      authChecking: true,
      isAdmin: false,
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => refreshedRequest.resolve(result(acknowledgement(ADMIN_A))))
    await waitFor(() => expect(view.result.current.isAdmin).toBe(true))
    expect(view.result.current.accessToken).toBe('token-a-refreshed')
  })

  it('never probes with a bearer replaced by proactive refresh', async () => {
    const refresh = deferred<string | null>()
    mockGetToken.mockReset()
    mockGetToken.mockReturnValueOnce(refresh.promise).mockResolvedValue('token-a-refreshed')
    mockAuthedFetch.mockResolvedValue(result(acknowledgement(ADMIN_A)))

    const view = renderHook(() => useAdminAuth())
    await waitFor(() => expect(mockGetToken).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).not.toHaveBeenCalled()

    await act(async () => {
      mockAuth = signedIn(ADMIN_A, 'token-a-refreshed', 1)
      view.rerender()
      refresh.resolve('token-a-refreshed')
      await refresh.promise
    })

    await waitFor(() => expect(view.result.current.isAdmin).toBe(true))
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/admin/authority',
      'GET',
      'token-a-refreshed',
      undefined,
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: ADMIN_A,
      })
    )
  })

  it('fails closed when an acknowledgement names another actor', async () => {
    mockAuthedFetch.mockResolvedValue(result(acknowledgement(USER_B)))

    const { result: hook } = renderHook(() => useAdminAuth())

    await waitFor(() => expect(hook.current.authChecking).toBe(false))
    expect(hook.current.isAdmin).toBe(false)
    expect(hook.current.accessToken).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('clears authority and redirects home after an exact server denial', async () => {
    mockAuthedFetch.mockResolvedValue(result({ success: false }, 403))

    const { result: hook } = renderHook(() => useAdminAuth())

    await waitFor(() => expect(hook.current.authChecking).toBe(false))
    expect(hook.current.isAdmin).toBe(false)
    expect(hook.current.accessToken).toBeNull()
    expect(mockToast).toHaveBeenCalledWith('u13admin_accessRequired', 'error')
    expect(mockReplace).toHaveBeenCalledWith('/')
  })

  it('fails closed without retrying or navigating when authority is unavailable', async () => {
    mockAuthedFetch.mockResolvedValue(result({ success: false }, 503))

    const view = renderHook(() => useAdminAuth())

    await waitFor(() => expect(view.result.current.authChecking).toBe(false))
    expect(view.result.current.isAdmin).toBe(false)
    expect(view.result.current.accessToken).toBeNull()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockReplace).not.toHaveBeenCalled()

    view.rerender()
    await act(async () => Promise.resolve())
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
  })

  it('aborts an unresolved authority probe on unmount', async () => {
    const pending = deferred<ReturnType<typeof result>>()
    let signal: AbortSignal | undefined
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        options: { signal?: AbortSignal }
      ) => {
        signal = options.signal
        return pending.promise
      }
    )

    const view = renderHook(() => useAdminAuth())
    await waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)

    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('redirects an anonymous viewer without probing the admin endpoint', async () => {
    mockAuth = {
      accessToken: null,
      authChecked: true,
      email: null,
      loading: false,
      sessionGeneration: 2,
      userId: null,
      viewerKey: 'anon',
    }

    const { result: hook } = renderHook(() => useAdminAuth())

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?returnUrl=%2Fadmin'))
    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(hook.current).toMatchObject({
      accessToken: null,
      authChecking: false,
      isAdmin: false,
      userId: null,
    })
  })
})
