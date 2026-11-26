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

/**
 * The denominator is get_hero_stats().trader_count, which counts only rows
 * with performance (idle_window = false, migration 20261124225312). Idle rows
 * are ranked after every scored row, so a scored trader's rank is its rank
 * among scored traders and an idle row's rank is greater than the count.
 */
describe('CrossExchangePercentileBadge counts only traders with performance', () => {
  // t() echoes the key, so the badge text is the key with {pct} still in it;
  // the tooltip carries the computed percentage and the denominator.
  const tooltip = () => screen.getByRole('img').getAttribute('aria-label')

  it('shows nothing for an idle-window row: its rank is outside the population', () => {
    // 4,000 traders with performance, 5,000 idle rows ranked 4,001..9,000.
    mockHeroStats = { traderCount: 4000, exchangeCount: 20, isDefault: false }
    for (const idleRank of [4001, 6000, 9000]) {
      const { container, unmount } = render(<CrossExchangePercentileBadge rank={idleRank} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('does not flatter a low-ranked trader by dividing by idle rows', () => {
    // Rank 3,000 of 4,000 with performance is the bottom half: no badge.
    // Over all 9,000 served rows it would have read "top 33%".
    mockHeroStats = { traderCount: 4000, exchangeCount: 20, isDefault: false }
    const { container, unmount } = render(<CrossExchangePercentileBadge rank={3000} />)
    expect(container).toBeEmptyDOMElement()
    unmount()

    render(<CrossExchangePercentileBadge rank={1000} />)
    expect(tooltip()).toBe('beatsTradersAcrossExchanges')
    expect(screen.getByText('topPercentOverall')).toBeInTheDocument()
  })

  it('is unchanged under the old rule, where no row is idle and the count is every served row', () => {
    // Same rank, same count as before the change: same badge or same absence.
    mockHeroStats = { traderCount: 4000, exchangeCount: 20, isDefault: false }
    const shown = (rank: number) => {
      const { container, unmount } = render(<CrossExchangePercentileBadge rank={rank} />)
      const visible = container.firstChild !== null
      unmount()
      return visible
    }
    expect([1, 40, 2000, 2019, 2020, 3999, 4000].map(shown)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })
})
