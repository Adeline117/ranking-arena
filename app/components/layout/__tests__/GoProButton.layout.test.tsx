import { render, screen } from '@testing-library/react'
import GoProButton from '../GoProButton'

const mockUseIsPremium = jest.fn()
const mockUsePremiumProviderPresent = jest.fn()

jest.mock('@/lib/premium/hooks', () => ({
  useIsPremium: () => mockUseIsPremium(),
  usePremiumProviderPresent: () => mockUsePremiumProviderPresent(),
}))

jest.mock('../../Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) => (key === 'goPro' ? '升级 Pro' : key),
  }),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

describe('GoProButton top-nav footprint', () => {
  beforeEach(() => {
    document.cookie = 'arena_tier=; Max-Age=0; Path=/'
    mockUsePremiumProviderPresent.mockReturnValue(true)
    mockUseIsPremium.mockReturnValue({
      isPremium: false,
      isLoading: false,
      tier: 'free',
    })
  })

  it('fills the reserved 72px slot for every localized label', () => {
    render(<GoProButton />)

    expect(screen.getByRole('link', { name: '升级 Pro' })).toHaveStyle({
      width: '100%',
      height: '30px',
    })
  })

  it('stays absent for loading and premium states while its parent keeps the slot', () => {
    mockUseIsPremium.mockReturnValue({
      isPremium: true,
      isLoading: false,
      tier: 'pro',
    })

    const { container } = render(<GoProButton />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the CTA on the provider-light homepage for free visitors', () => {
    mockUsePremiumProviderPresent.mockReturnValue(false)
    mockUseIsPremium.mockReturnValue({
      isPremium: false,
      isLoading: true,
      tier: 'free',
    })

    render(<GoProButton />)
    expect(screen.getByRole('link', { name: '升级 Pro' })).toBeVisible()
  })

  it('honors the paid-tier cookie outside PremiumProvider', () => {
    document.cookie = 'arena_tier=pro; Path=/'
    mockUsePremiumProviderPresent.mockReturnValue(false)
    mockUseIsPremium.mockReturnValue({
      isPremium: false,
      isLoading: true,
      tier: 'free',
    })

    const { container } = render(<GoProButton />)
    expect(container).toBeEmptyDOMElement()
  })
})
