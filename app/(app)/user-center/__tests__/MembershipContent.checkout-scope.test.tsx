import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AuthSessionReturn } from '@/lib/hooks/useAuthSession'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockAuthedFetch = jest.fn()
const mockShowToast = jest.fn()
const mockRouterPush = jest.fn()
const mockTrackEvent = jest.fn()
let mockAuth: AuthSessionReturn

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/premium/hooks', () => ({
  usePremium: () => ({ isPremium: false }),
  FEATURE_LIMITS: {
    free: { maxFollows: 10 },
    pro: { maxFollows: 100 },
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

jest.mock('../CurrentPlanCard', () => ({
  __esModule: true,
  default: () => <div>current-plan</div>,
}))

jest.mock('../UpgradeSection', () => ({
  __esModule: true,
  default: ({
    selectedPlan,
    setSelectedPlan,
    subscribing,
    onSubscribe,
  }: {
    selectedPlan: string
    setSelectedPlan: (plan: 'monthly') => void
    subscribing: boolean
    onSubscribe: () => void
  }) => (
    <div>
      <span data-testid="selected-plan">{selectedPlan}</span>
      <span data-testid="checkout-state">{subscribing ? 'processing' : 'idle'}</span>
      <button onClick={() => setSelectedPlan('monthly')}>select-monthly</button>
      <button disabled={subscribing} onClick={onSubscribe}>
        subscribe
      </button>
    </div>
  ),
}))

jest.mock('../ProFeaturesList', () => ({ __esModule: true, default: () => null }))
jest.mock('../NftMembershipCard', () => ({ __esModule: true, default: () => null }))
jest.mock('../ComparisonTable', () => ({ __esModule: true, default: () => null }))
jest.mock('../UsageStatsCard', () => ({ __esModule: true, default: () => null }))
jest.mock('../FaqSection', () => ({ __esModule: true, default: () => null }))
jest.mock('../SubscriptionManagement', () => ({ __esModule: true, default: () => null }))

import MembershipContent from '../MembershipContent'

type CheckoutResult = {
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
  const accessToken = jwt(userId)
  return {
    user: { id: userId, email: `${userId}@example.com`, identities: [] },
    userId,
    email: `${userId}@example.com`,
    accessToken,
    isLoggedIn: true,
    loading: false,
    authChecked: true,
    viewerKey: `user:${userId}`,
    sessionGeneration,
    getAuthHeadersAsync: async () => ({ Authorization: `Bearer ${accessToken}` }),
  } as unknown as AuthSessionReturn
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function installMembershipReads(): void {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/subscription') return Promise.resolve(response({ subscription: null }))
    if (url === '/api/membership/nft') return Promise.resolve(response({ hasNft: false }))
    return Promise.resolve(response({ followedTraders: 0, apiCallsToday: 0 }))
  }) as jest.Mock
}

function switchToUserB(rerender: () => void): number {
  const transition = beginViewerTransition('user-b')
  const scope = commitViewerTransition(transition, 'user-b')!
  mockAuth = authFor('user-b', scope.sessionGeneration)
  rerender()
  return scope.sessionGeneration
}

describe('MembershipContent checkout viewer ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    mockAuth = authFor('user-a', scope.sessionGeneration)
    installMembershipReads()
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('binds the write to the exact viewer and synchronously rejects a double click', async () => {
    const checkout = deferred<CheckoutResult>()
    mockAuthedFetch.mockReturnValue(checkout.promise)
    const redirect = jest.fn()
    render(<MembershipContent redirectToCheckout={redirect} />)

    const subscribe = await screen.findByRole('button', { name: 'subscribe' })
    fireEvent.click(subscribe)
    fireEvent.click(subscribe)

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/stripe/create-checkout',
      'POST',
      jwt('user-a'),
      expect.objectContaining({
        plan: 'yearly',
        operationId: '00000000-0000-4000-8000-000000000001',
      }),
      20_000,
      expect.objectContaining({
        expectedUserId: 'user-a',
        expectedSessionGeneration: mockAuth.sessionGeneration,
        signal: expect.any(AbortSignal),
      })
    )
    expect(screen.getByTestId('checkout-state')).toHaveTextContent('processing')

    checkout.resolve({ ok: false, status: 503, data: { error: 'unavailable' } })
    await waitFor(() => expect(screen.getByTestId('checkout-state')).toHaveTextContent('idle'))
    expect(redirect).not.toHaveBeenCalled()
  })

  it('hides A state immediately and drops A checkout URL after switching to B', async () => {
    const checkoutA = deferred<CheckoutResult>()
    mockAuthedFetch.mockReturnValue(checkoutA.promise)
    const redirect = jest.fn()
    const view = render(<MembershipContent redirectToCheckout={redirect} />)

    await screen.findByRole('button', { name: 'subscribe' })
    fireEvent.click(screen.getByRole('button', { name: 'select-monthly' }))
    expect(screen.getByTestId('selected-plan')).toHaveTextContent('monthly')
    fireEvent.click(screen.getByRole('button', { name: 'subscribe' }))
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('checkout-state')).toHaveTextContent('processing')

    act(() => {
      switchToUserB(() => view.rerender(<MembershipContent redirectToCheckout={redirect} />))
    })

    expect(await screen.findByTestId('selected-plan')).toHaveTextContent('yearly')
    expect(screen.getByTestId('checkout-state')).toHaveTextContent('idle')

    await act(async () => {
      checkoutA.resolve({
        ok: true,
        status: 200,
        data: { url: 'https://checkout.stripe.com/session-for-user-a' },
      })
      await Promise.resolve()
    })

    expect(redirect).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(mockRouterPush).not.toHaveBeenCalled()
    expect(mockTrackEvent).toHaveBeenCalledWith('start_checkout', { plan: 'monthly' })
  })
})
