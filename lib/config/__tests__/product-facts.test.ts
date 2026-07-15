import { PRODUCT_FACTS, buildProductFactsSnapshot, formatRankedTraderCount } from '../product-facts'

describe('product facts', () => {
  it('uses one operational fallback when live facts are unavailable', () => {
    expect(buildProductFactsSnapshot()).toEqual({
      exchangeCount: PRODUCT_FACTS.fallbackExchangeCount,
      rankedTraderCount: PRODUCT_FACTS.fallbackRankedTraderCount,
      leaderboardRefreshHours: 2,
      leaderboardRefreshLabel: '2h',
      sourceRefreshLabel: '3-6h',
      isFallback: true,
    })
  })

  it('prefers valid live counts without changing the scheduler cadence', () => {
    expect(
      buildProductFactsSnapshot({ exchangeCount: 21, traderCount: 12_345, isDefault: false })
    ).toMatchObject({
      exchangeCount: 21,
      rankedTraderCount: 12_345,
      leaderboardRefreshLabel: '2h',
      isFallback: false,
    })
  })

  it('formats ranked counts for display without changing their meaning', () => {
    expect(formatRankedTraderCount(9_600)).toBe('9,600')
  })
})
