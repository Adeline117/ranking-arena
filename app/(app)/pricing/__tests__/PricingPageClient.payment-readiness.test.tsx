import { render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/types/premium', () => ({
  ...jest.requireActual('@/lib/types/premium'),
  PRO_FREE_PROMO: false,
}))

const mockAuthSession = {
  email: null as string | null,
  userId: null as string | null,
  getAuthHeadersAsync: undefined as (() => Promise<Record<string, string>>) | undefined,
}
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthSession,
}))

const mockDirectCheckout = jest.fn()
jest.mock('@/lib/hooks/useDirectCheckout', () => ({
  useDirectCheckout: () => ({
    checkout: mockDirectCheckout,
    isLoading: false,
    error: null,
    alreadySubscribed: false,
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/ui/Toast', () => ({ useToast: () => ({ showToast: jest.fn() }) }))
jest.mock('@/lib/hooks/useProductFacts', () => ({
  useProductFacts: () => ({ sourceBoardCount: 44, leaderboardRefreshLabel: '2h' }),
}))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import PricingPageClient from '../PricingPageClient'

const COMING_SOON = 'Payment system coming soon'

function mockSubscription(subscription: { tier: string; plan?: string }) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ subscription }),
  })) as unknown as typeof fetch
}

describe('PricingPageClient payment readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/pricing')
    mockAuthSession.email = null
    mockAuthSession.userId = null
    mockAuthSession.getAuthHeadersAsync = undefined
  })

  it('renders disabled coming-soon CTAs for anonymous viewers when payments are not ready', () => {
    const { container } = render(
      <PricingPageClient paymentsReady={false} lifetimeCheckoutReady={false} />
    )
    const comingSoon = screen.getAllByRole('button', { name: COMING_SOON })
    expect(comingSoon).toHaveLength(2)
    comingSoon.forEach((button) => expect(button).toBeDisabled())

    const hrefs = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href^="/login?returnUrl="]')
    ).map((link) => link.getAttribute('href'))
    // Free signup stays available; no paid/trial/lifetime path leads to a 503.
    expect(hrefs.some((href) => href?.includes('plan%3Dfree'))).toBe(true)
    expect(hrefs.some((href) => /plan%3D(pro|trial|lifetime)/.test(href ?? ''))).toBe(false)
  })

  it('disables purchase and trial buttons for signed-in Free viewers when payments are not ready', async () => {
    mockAuthSession.email = 'viewer@example.com'
    mockAuthSession.userId = 'user-1'
    mockAuthSession.getAuthHeadersAsync = async () => ({ Authorization: 'Bearer t' })
    mockSubscription({ tier: 'free' })

    render(<PricingPageClient paymentsReady={false} lifetimeCheckoutReady={false} />)
    await waitFor(() => expect(screen.getByText('Current Plan')).toBeInTheDocument())

    expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start 7-Day Free Trial' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Get Founding Member Access' })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: COMING_SOON })).toHaveLength(2)
    expect(mockDirectCheckout).not.toHaveBeenCalled()
  })

  it('keeps Pro checkout but closes only the lifetime CTA when lifetime checkout is gated', async () => {
    mockAuthSession.email = 'viewer@example.com'
    mockAuthSession.userId = 'user-1'
    mockAuthSession.getAuthHeadersAsync = async () => ({ Authorization: 'Bearer t' })
    mockSubscription({ tier: 'free' })

    render(<PricingPageClient paymentsReady lifetimeCheckoutReady={false} />)
    await waitFor(() => expect(screen.getByText('Current Plan')).toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Start 7-Day Free Trial' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Get Founding Member Access' })
    ).not.toBeInTheDocument()
    const comingSoon = screen.getByRole('button', { name: COMING_SOON })
    expect(comingSoon).toBeDisabled()
  })

  it('still shows the lifetime-owner label instead of coming-soon for lifetime members', async () => {
    mockAuthSession.email = 'viewer@example.com'
    mockAuthSession.userId = 'user-1'
    mockAuthSession.getAuthHeadersAsync = async () => ({ Authorization: 'Bearer t' })
    mockSubscription({ tier: 'pro', plan: 'lifetime' })

    render(<PricingPageClient paymentsReady={false} lifetimeCheckoutReady={false} />)
    await waitFor(() => expect(screen.getAllByText('You have Lifetime Pro')).toHaveLength(2))
    expect(screen.queryByRole('button', { name: COMING_SOON })).not.toBeInTheDocument()
  })
})
