import { render, screen } from '@testing-library/react'
import CrossExchangePercentileBadge from '../CrossExchangePercentileBadge'

let mockHeroStats: { traderCount: number; exchangeCount: number; isDefault?: boolean } | undefined
jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mockHeroStats }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

describe('CrossExchangePercentileBadge denominator authority', () => {
  it('renders nothing when hero stats are the default/fallback payload', () => {
    mockHeroStats = { traderCount: 9600, exchangeCount: 28, isDefault: true }
    const { container } = render(<CrossExchangePercentileBadge rank={10} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing before hero stats load', () => {
    mockHeroStats = undefined
    const { container } = render(<CrossExchangePercentileBadge rank={10} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the percentile for a real (non-default) count', () => {
    mockHeroStats = { traderCount: 1000, exchangeCount: 20, isDefault: false }
    render(<CrossExchangePercentileBadge rank={10} />)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})
