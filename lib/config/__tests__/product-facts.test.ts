import {
  HOMEPAGE_TRUST_COPY,
  PRODUCT_FACTS,
  buildProductFactsSnapshot,
  formatRankedTraderCount,
  formatLiveSourceBoardCoverage,
  publicCount,
} from '../product-facts'

describe('product facts', () => {
  it('states no count at all when live facts are unavailable', () => {
    const unavailable = {
      sourceBoardCount: null,
      rankedTraderCount: null,
      leaderboardRefreshHours: 2,
      leaderboardRefreshLabel: '2h',
      sourceRefreshLabel: '3-6h',
      isFallback: true,
    }
    expect(buildProductFactsSnapshot()).toEqual(unavailable)
    // Lookup defaults are placeholders whatever numbers they carry.
    expect(
      buildProductFactsSnapshot({ sourceBoardCount: 28, traderCount: 9_600, isDefault: true })
    ).toEqual(unavailable)
    expect(PRODUCT_FACTS).not.toHaveProperty('fallbackSourceBoardCount')
    expect(PRODUCT_FACTS).not.toHaveProperty('fallbackRankedTraderCount')
  })

  it('does not invent a number for a genuinely empty public board', () => {
    // After the launch migrations the boards are empty until the pipeline
    // refills them; the live answer is 0, which must not become "9,600".
    expect(buildProductFactsSnapshot({ sourceBoardCount: 0, traderCount: 0 })).toMatchObject({
      sourceBoardCount: null,
      rankedTraderCount: null,
      isFallback: false,
    })
  })

  it('only treats a positive integer as a publishable count', () => {
    expect(publicCount(21)).toBe(21)
    for (const value of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '21', null, undefined]) {
      expect(publicCount(value)).toBeNull()
    }
  })

  it('prefers valid live counts without changing the scheduler cadence', () => {
    expect(
      buildProductFactsSnapshot({ sourceBoardCount: 21, traderCount: 12_345, isDefault: false })
    ).toMatchObject({
      sourceBoardCount: 21,
      rankedTraderCount: 12_345,
      leaderboardRefreshLabel: '2h',
      isFallback: false,
    })
  })

  it('accepts the legacy exchangeCount response without changing its meaning', () => {
    expect(buildProductFactsSnapshot({ exchangeCount: 19 })).toMatchObject({
      sourceBoardCount: 19,
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
    expect(formatLiveSourceBoardCoverage(28)).toBe('28 live ranking source boards')
    expect(formatLiveSourceBoardCoverage(Number.POSITIVE_INFINITY)).toBe(
      'live public ranking sources'
    )
    expect(formatLiveSourceBoardCoverage()).toBe('live public ranking sources')
  })
})
