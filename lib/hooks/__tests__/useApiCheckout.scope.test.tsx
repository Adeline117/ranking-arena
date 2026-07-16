import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockPush = jest.fn()
const mockAuthedFetch = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

import { useApiCheckout } from '../useApiCheckout'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

function authFor(userId: string, sessionGeneration: number, tokenUserId = userId) {
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(tokenUserId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

describe('useApiCheckout viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
  })

  it('uses one exact canonical token snapshot through checkout and redirect', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { url: 'https://checkout.stripe.test/session-a', sessionId: 'cs_a' },
    })
    const redirect = jest.fn()
    const hook = renderHook(() => useApiCheckout({ redirectToCheckout: redirect }))

    await act(async () => {
      await hook.result.current.checkout('starter')
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/stripe/create-api-checkout',
      'POST',
      jwt('user-a'),
      { plan: 'starter' },
      20_000,
      {
        expectedUserId: 'user-a',
        expectedSessionGeneration: scope.sessionGeneration,
      }
    )
    expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.test/session-a')
    expect(hook.result.current.isLoading).toBe(false)
  })

  it('drops A checkout after A -> B and lets B start without waiting for A', async () => {
    const responseA = deferred<{
      ok: boolean
      status: number
      data: { url: string }
    }>()
    const responseB = deferred<{
      ok: boolean
      status: number
      data: { url: string }
    }>()
    mockAuthedFetch.mockReturnValueOnce(responseA.promise).mockReturnValueOnce(responseB.promise)

    const scopeA = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scopeA.sessionGeneration)
    const redirect = jest.fn()
    const hook = renderHook(() => useApiCheckout({ redirectToCheckout: redirect }))

    let checkoutA!: Promise<void>
    act(() => {
      checkoutA = hook.result.current.checkout('starter')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    mockAuth = authFor('user-b', scopeB.sessionGeneration)
    hook.rerender()

    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.error).toBeNull()

    let checkoutB!: Promise<void>
    act(() => {
      checkoutB = hook.result.current.checkout('pro')
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))

    await act(async () => {
      responseB.resolve({
        ok: true,
        status: 200,
        data: { url: 'https://checkout.stripe.test/session-b' },
      })
      await checkoutB
    })
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.test/session-b')

    await act(async () => {
      responseA.resolve({
        ok: true,
        status: 200,
        data: { url: 'https://checkout.stripe.test/session-a' },
      })
      await checkoutA
    })
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch.mock.calls[1][5]).toEqual({
      expectedUserId: 'user-b',
      expectedSessionGeneration: scopeB.sessionGeneration,
    })
  })

  it('fails closed when the canonical user and JWT subject differ', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration, 'user-b')
    const redirect = jest.fn()
    const hook = renderHook(() => useApiCheckout({ redirectToCheckout: redirect }))

    await act(async () => {
      await hook.result.current.checkout('starter')
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('routes a resolved anonymous viewer to login without creating checkout', async () => {
    const scope = synchronizeViewerScope(true, null)
    mockAuth = {
      user: null,
      userId: null,
      email: null,
      accessToken: null,
      isLoggedIn: false,
      loading: false,
      authChecked: true,
      viewerKey: scope.viewerKey,
      sessionGeneration: scope.sessionGeneration,
    } as unknown as AuthSessionReturn
    const hook = renderHook(() => useApiCheckout())

    await act(async () => {
      await hook.result.current.checkout('starter')
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith('/login?redirect=%2Fapi-docs')
  })
})
