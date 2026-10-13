import { render, screen, waitFor } from '@testing-library/react'

jest.mock('@/lib/types/premium', () => ({
  ...jest.requireActual('@/lib/types/premium'),
  PRO_FREE_PROMO: false,
}))

const mockGetAuthHeadersAsync = jest.fn(async () => ({ Authorization: 'Bearer t' }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    email: 'viewer@example.com',
    userId: 'user-1',
    getAuthHeadersAsync: mockGetAuthHeadersAsync,
  }),
}))

jest.mock('@/lib/hooks/useDirectCheckout', () => ({
  useDirectCheckout: () => ({
    checkout: jest.fn(),
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

function mockSubscription(subscription: { tier: string; plan?: string }) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ subscription }),
  })) as unknown as typeof fetch
}

describe('PricingPageClient viewer plan state', () => {
  it('labels Free as the current plan only for a real Free subscriber', async () => {
    mockSubscription({ tier: 'free' })
    render(<PricingPageClient paymentsReady lifetimeCheckoutReady />)
    await waitFor(() => expect(screen.getByText('Current Plan')).toBeInTheDocument())
  })

  it('does not label Free as current for a Pro subscriber', async () => {
    mockSubscription({ tier: 'pro', plan: 'monthly' })
    render(<PricingPageClient paymentsReady lifetimeCheckoutReady />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Current Plan')).not.toBeInTheDocument())
  })

  it('hides purchase buttons for lifetime members', async () => {
    mockSubscription({ tier: 'pro', plan: 'lifetime' })
    render(<PricingPageClient paymentsReady lifetimeCheckoutReady />)
    await waitFor(() => expect(screen.getAllByText('You have Lifetime Pro')).toHaveLength(2))
    expect(screen.queryByText('Get Founding Member Access')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Upgrade to Pro' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start 7-Day Free Trial' })).not.toBeInTheDocument()
  })
})
