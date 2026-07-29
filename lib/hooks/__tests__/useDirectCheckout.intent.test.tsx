import { act, renderHook, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import type { PricingCheckoutIntent } from '@/lib/premium/pricing-login-intent'
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

import { useDirectCheckout } from '../useDirectCheckout'

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

function anonymousAuth(sessionGeneration: number) {
  return {
    user: null,
    userId: null,
    email: null,
    accessToken: null,
    isLoggedIn: false,
    loading: false,
    authChecked: true,
    viewerKey: 'anon',
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

describe('useDirectCheckout viewer-owned intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
  })

  it.each<[label: string, intent: PricingCheckoutIntent, expectedHref: string]>([
    [
      'monthly Pro',
      { plan: 'monthly' },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dpro%26billing%3Dmonthly',
    ],
    [
      'yearly trial',
      { plan: 'yearly', trial: true },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly',
    ],
    [
      'lifetime from the monthly view',
      { plan: 'lifetime', billing: 'monthly' },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dlifetime%26billing%3Dmonthly',
    ],
  ])('preserves %s for a resolved anonymous viewer', async (_label, intent, expectedHref) => {
    const scope = synchronizeViewerScope(true, null)
    mockAuth = anonymousAuth(scope.sessionGeneration)
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout(intent)
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(expectedHref)
  })

  it('preserves trial and billing after the checkout API rejects the exact viewer', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: 'Unauthorized' },
    })
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'yearly', trial: true })
    })

    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/stripe/create-checkout',
      'POST',
      jwt('user-a'),
      expect.objectContaining({
        plan: 'yearly',
        trial: true,
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      }),
      20_000,
      {
        expectedUserId: 'user-a',
        expectedSessionGeneration: scope.sessionGeneration,
      }
    )
    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly'
    )
  })

  it('reuses one durable recurring operation across same-viewer technical retries', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      data: { error: 'Temporarily unavailable' },
    })
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })
    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    const bodies = mockAuthedFetch.mock.calls.map((call) => call[3] as Record<string, unknown>)
    expect(bodies).toHaveLength(2)
    expect(bodies[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(bodies[1].operationId).toBe(bodies[0].operationId)
  })

  it('admits only one checkout for rapid same-viewer double clicks', async () => {
    const response = deferred<{
      ok: boolean
      status: number
      data: { url: string }
    }>()
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockReturnValue(response.promise)
    const redirect = jest.fn()
    const hook = renderHook(() => useDirectCheckout({ redirectToCheckout: redirect }))

    let first!: Promise<void>
    act(() => {
      first = hook.result.current.checkout({ plan: 'yearly' })
      void hook.result.current.checkout({ plan: 'yearly' })
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    await act(async () => {
      response.resolve({
        ok: true,
        status: 200,
        data: { url: 'https://checkout.stripe.test/session-a' },
      })
      await first
    })
    expect(redirect).toHaveBeenCalledTimes(1)
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
    const hook = renderHook(() => useDirectCheckout({ redirectToCheckout: redirect }))

    let checkoutA!: Promise<void>
    act(() => {
      checkoutA = hook.result.current.checkout({ plan: 'monthly' })
    })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(hook.result.current.isLoading).toBe(true)

    const transition = beginViewerTransition('user-b')
    const scopeB = commitViewerTransition(transition, 'user-b')!
    mockAuth = authFor('user-b', scopeB.sessionGeneration)
    hook.rerender()

    expect(hook.result.current.isLoading).toBe(false)
    expect(hook.result.current.error).toBeNull()

    let checkoutB!: Promise<void>
    act(() => {
      checkoutB = hook.result.current.checkout({ plan: 'monthly' })
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

    const bodies = mockAuthedFetch.mock.calls.map((call) => call[3] as Record<string, unknown>)
    expect(bodies[1].operationId).not.toBe(bodies[0].operationId)
    expect(mockAuthedFetch.mock.calls[1][5]).toEqual({
      expectedUserId: 'user-b',
      expectedSessionGeneration: scopeB.sessionGeneration,
    })
  })

  it('fails closed when the canonical viewer and JWT subject differ', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration, 'user-b')
    const redirect = jest.fn()
    const hook = renderHook(() => useDirectCheckout({ redirectToCheckout: redirect }))

    await act(async () => {
      await hook.result.current.checkout({ plan: 'lifetime' })
    })

    expect(mockAuthedFetch).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
  })
})
