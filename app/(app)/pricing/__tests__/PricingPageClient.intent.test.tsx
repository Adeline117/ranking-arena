import { render, waitFor } from '@testing-library/react'

const mockDirectCheckout = jest.fn()

jest.mock('@/lib/types/premium', () => ({
  ...jest.requireActual('@/lib/types/premium'),
  PRO_FREE_PROMO: false,
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ email: null }),
}))

jest.mock('@/lib/hooks/useDirectCheckout', () => ({
  useDirectCheckout: () => ({
    checkout: mockDirectCheckout,
    isLoading: false,
    error: null,
    alreadySubscribed: false,
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/hooks/useProductFacts', () => ({
  useProductFacts: () => ({
    sourceBoardCount: 44,
    leaderboardRefreshLabel: '2h',
  }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

import PricingPageClient from '../PricingPageClient'

describe('PricingPageClient anonymous plan intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/pricing?billing=monthly')
  })

  it('wires all four CTAs to a typed internal login return without auto-checkout', async () => {
    const { container } = render(<PricingPageClient />)
    const expectedHrefs = [
      '/login?returnUrl=%2Fpricing%3Fplan%3Dfree%26billing%3Dmonthly',
      '/login?returnUrl=%2Fpricing%3Fplan%3Dpro%26billing%3Dmonthly',
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dmonthly',
      '/login?returnUrl=%2Fpricing%3Fplan%3Dlifetime%26billing%3Dmonthly',
    ]

    await waitFor(() => {
      const hrefs = Array.from(
        container.querySelectorAll<HTMLAnchorElement>('a[href^="/login?returnUrl="]')
      ).map((link) => link.getAttribute('href'))
      expect(hrefs).toEqual(expect.arrayContaining(expectedHrefs))
    })

    expect(mockDirectCheckout).not.toHaveBeenCalled()
  })
})
