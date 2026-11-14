import { RankingsResponseSchema, TradersListResponseSchema } from '../core-api'

const valid = {
  traders: [
    {
      id: 'a',
      handle: 'A',
      source: 'hyperliquid',
      rank: 1,
      roi: null,
      pnl: null,
      win_rate: null,
      max_drawdown: null,
      arena_score: null,
      avatar_url: null,
      followers: null,
      trades_count: null,
    },
  ],
  timeRange: '30D',
  totalCount: null,
  totalCountIsExact: false,
  hasMore: false,
  isStale: false,
  lastUpdated: null,
  availableSources: [],
  source_freshness: [],
}

describe('core API contracts', () => {
  it('accepts null metrics, which mean the source did not provide them', () => {
    expect(TradersListResponseSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a response that drops a field clients read', () => {
    const { hasMore: _hasMore, ...withoutHasMore } = valid
    expect(TradersListResponseSchema.safeParse(withoutHasMore).success).toBe(false)
  })

  it('rejects a row without a published rank', () => {
    const traders = [{ ...valid.traders[0], rank: 0 }]
    expect(TradersListResponseSchema.safeParse({ ...valid, traders }).success).toBe(false)
  })

  it('rejects an unknown period', () => {
    expect(TradersListResponseSchema.safeParse({ ...valid, timeRange: '1D' }).success).toBe(false)
  })
})

describe('rankings contract window', () => {
  const rankings = (window: string) => ({
    success: true,
    data: {
      traders: [],
      window,
      hasMore: false,
      is_stale: false,
      as_of: null,
      source_freshness: [],
    },
    meta: { timestamp: '2026-11-14T00:00:00.000Z' },
  })

  it('accepts the composite window that window=composite answers with', () => {
    expect(RankingsResponseSchema.safeParse(rankings('COMPOSITE')).success).toBe(true)
    expect(RankingsResponseSchema.safeParse(rankings('90D')).success).toBe(true)
  })

  it('rejects an unknown window', () => {
    expect(RankingsResponseSchema.safeParse(rankings('1D')).success).toBe(false)
  })
})
