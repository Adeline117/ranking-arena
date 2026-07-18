import {
  HOMEPAGE_TRUST_COPY,
  PRODUCT_FACTS,
  buildProductFactsSnapshot,
  formatRankedTraderCount,
  formatTrackedSourceCoverage,
} from '../product-facts'

describe('product facts', () => {
  it('uses one operational fallback when live facts are unavailable', () => {
    expect(buildProductFactsSnapshot()).toEqual({
      sourceBoardCount: PRODUCT_FACTS.fallbackSourceBoardCount,
      exchangeCount: PRODUCT_FACTS.fallbackSourceBoardCount,
      rankedTraderCount: PRODUCT_FACTS.fallbackRankedTraderCount,
      leaderboardRefreshHours: 2,
      leaderboardRefreshLabel: '2h',
      sourceRefreshLabel: '3-6h',
      isFallback: true,
    })
  })

  it('prefers valid live counts without changing the scheduler cadence', () => {
    expect(
      buildProductFactsSnapshot({ sourceBoardCount: 21, traderCount: 12_345, isDefault: false })
    ).toMatchObject({
      sourceBoardCount: 21,
      exchangeCount: 21,
      rankedTraderCount: 12_345,
      leaderboardRefreshLabel: '2h',
      isFallback: false,
    })
  })

  it('accepts the legacy exchangeCount response without changing its meaning', () => {
    expect(buildProductFactsSnapshot({ exchangeCount: 19 })).toMatchObject({
      sourceBoardCount: 19,
      exchangeCount: 19,
    })
  })

  it('formats ranked counts for display without changing their meaning', () => {
    expect(formatRankedTraderCount(9_600)).toBe('9,600')
  })

  it('keeps homepage freshness and coverage copy on the shared product facts', () => {
    expect(HOMEPAGE_TRUST_COPY.metadataDescription).toContain('recomputed every 2 hours')
    expect(HOMEPAGE_TRUST_COPY.metadataDescription).not.toMatch(/real[- ]?time/i)
    expect(HOMEPAGE_TRUST_COPY.ogCoverageLabel).toBe('Tracked Public Sources')
    expect(HOMEPAGE_TRUST_COPY.ogCadenceLabel).toBe('Recomputed Every 2h')
    expect(Object.values(HOMEPAGE_TRUST_COPY).join(' ')).not.toContain('32+')
    expect(formatTrackedSourceCoverage(18)).toBe('18 tracked source families')
    expect(formatTrackedSourceCoverage(Number.POSITIVE_INFINITY)).toBe('tracked public sources')
    expect(formatTrackedSourceCoverage()).toBe('tracked public sources')
  })
})
