import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import SubscriptionManagement from '../SubscriptionManagement'

const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

const info = {
  subscription: {
    tier: 'pro' as const,
    status: 'active',
    plan: 'monthly',
    cancelAtPeriodEnd: false,
  },
  nft: null,
  usage: {
    followedTraders: 0,
    apiCallsToday: 0,
  },
}

const getAuthHeadersAsync = jest.fn(async () => ({ Authorization: 'Bearer legacy-token' }))
const t = (key: string) => key

type PortalResult = {
  ok: boolean
  status: number
  data: { url?: string; error?: string } | null
  stale?: boolean
}

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

function authFor(userId: string, sessionGeneration: number): AuthSessionReturn {
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken: jwt(userId),
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  } as unknown as AuthSessionReturn
}

function renderManagement(redirectToPortal = jest.fn()) {
  return render(
    <SubscriptionManagement
      info={info}
      cardStyle={{}}
      getAuthHeadersAsync={getAuthHeadersAsync}
      t={t}
      redirectToPortal={redirectToPortal}
    />
  )
}

function switchToUserB(rerender: () => void): number {
  const transition = beginViewerTransition('user-b')
  const scope = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scope.sessionGeneration)
  rerender()
  return scope.sessionGeneration
}

describe('SubscriptionManagement Billing Portal flows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    mockAuthedFetch.mockResolvedValue({
      ok: false,
      status: 503,
      data: { error: 'unavailable' },
    })
  })

  it('offers only exact payment-method and cancellation actions bound to the viewer', async () => {
    renderManagement()

    expect(screen.queryByRole('button', { name: 'changePlan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'billingHistory' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'paymentMethods' }))

    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/stripe/portal',
        'POST',
        jwt('user-a'),
        {
          flow: 'payment_method_update',
          scope: 'membership',
        },
        15_000,
        expect.objectContaining({
          expectedUserId: 'user-a',
          expectedSessionGeneration: mockAuth.sessionGeneration,
          signal: expect.any(AbortSignal),
        })
      )
    )
    expect(JSON.stringify(mockAuthedFetch.mock.calls[0])).not.toContain('subscription_update')
    expect(getAuthHeadersAsync).not.toHaveBeenCalled()
  })

  it('sends the confirmed cancellation as an exact membership deep link', async () => {
    renderManagement()

    fireEvent.click(screen.getByRole('button', { name: 'cancelSubscription' }))
    expect(screen.getByText('cancelSubscriptionConfirm')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'confirmCancel' }))

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch.mock.calls[0][3]).toEqual({
      flow: 'subscription_cancel',
      scope: 'membership',
    })
  })

  it('prevents duplicate portal sessions synchronously while an action is in flight', async () => {
    const pending = deferred<PortalResult>()
    mockAuthedFetch.mockReturnValue(pending.promise)
    renderManagement()

    const paymentButton = screen.getByRole('button', { name: 'paymentMethods' })
    fireEvent.click(paymentButton)
    fireEvent.click(paymentButton)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(paymentButton).toBeDisabled()

    pending.resolve({ ok: false, status: 503, data: { error: 'unavailable' } })
    await waitFor(() => expect(paymentButton).toBeEnabled())
  })

  it('rejects a non-Stripe portal URL and releases the controls', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { url: 'https://attacker.example/fake-billing-portal' },
    })
    const redirect = jest.fn()
    renderManagement(redirect)

    const paymentButton = screen.getByRole('button', { name: 'paymentMethods' })
    fireEvent.click(paymentButton)

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('paymentSystemComingSoon', 'error')
    )
    expect(redirect).not.toHaveBeenCalled()
    expect(paymentButton).toBeEnabled()
  })

  it('hides A controls and drops A portal URL after switching to B', async () => {
    const pendingA = deferred<PortalResult>()
    const pendingB = deferred<PortalResult>()
    mockAuthedFetch.mockImplementation((_url: string, _method: string, accessToken: string) =>
      accessToken === jwt('user-a') ? pendingA.promise : pendingB.promise
    )
    const redirect = jest.fn()
    const view = renderManagement(redirect)

    fireEvent.click(screen.getByRole('button', { name: 'cancelSubscription' }))
    expect(screen.getByText('cancelSubscriptionConfirm')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'paymentMethods' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    let generationB = 0
    act(() => {
      generationB = switchToUserB(() =>
        view.rerender(
          <SubscriptionManagement
            info={info}
            cardStyle={{}}
            getAuthHeadersAsync={getAuthHeadersAsync}
            t={t}
            redirectToPortal={redirect}
          />
        )
      )
    })

    expect(screen.queryByText('cancelSubscriptionConfirm')).not.toBeInTheDocument()
    const paymentButtonB = screen.getByRole('button', { name: 'paymentMethods' })
    expect(paymentButtonB).toBeEnabled()
    fireEvent.click(paymentButtonB)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(mockAuthedFetch.mock.calls[1][2]).toBe(jwt('user-b'))
    expect(mockAuthedFetch.mock.calls[1][5]).toEqual(
      expect.objectContaining({
        expectedUserId: 'user-b',
        expectedSessionGeneration: generationB,
      })
    )

    pendingB.resolve({ ok: false, status: 503, data: { error: 'unavailable' } })
    await waitFor(() => expect(paymentButtonB).toBeEnabled())
    expect(mockShowToast).toHaveBeenCalledWith('paymentSystemComingSoon', 'error')
    mockShowToast.mockClear()

    await act(async () => {
      pendingA.resolve({
        ok: true,
        status: 200,
        data: { url: 'https://billing.stripe.com/session-for-user-a' },
      })
      await Promise.resolve()
    })

    expect(redirect).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
  })
})
