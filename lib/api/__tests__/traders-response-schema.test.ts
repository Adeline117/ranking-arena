import { tradersResponseSchema } from '../traders-response-schema'

const baseResponse = {
  traders: [],
  timeRange: '90D',
  totalCount: null,
  totalCountIsExact: false,
  rankingMode: 'arena_score',
  lastUpdated: null,
  isStale: true,
  nextCursor: null,
  hasMore: false,
  limit: 50,
  availableSources: [],
}

describe('tradersResponseSchema', () => {
  it('accepts an unknown total only when its exactness is explicit', () => {
    expect(tradersResponseSchema.safeParse(baseResponse).success).toBe(true)
    expect(
      tradersResponseSchema.safeParse({
        ...baseResponse,
        totalCount: 0,
        totalCountIsExact: true,
      }).success
    ).toBe(true)
  })

  it('requires totalCountIsExact and rejects invalid numeric totals', () => {
    const { totalCountIsExact: _totalCountIsExact, ...missingExactness } = baseResponse

    expect(tradersResponseSchema.safeParse(missingExactness).success).toBe(false)
    expect(tradersResponseSchema.safeParse({ ...baseResponse, totalCount: -1 }).success).toBe(false)
  })

  it('accepts rows whose roi / arena_score are null (unknown), as the route emits', () => {
    const row = {
      id: 't1',
      handle: null,
      source: 'bybit',
      source_type: 'futures',
      rank: 1,
      roi: null,
      pnl: null,
      win_rate: null,
      max_drawdown: null,
      arena_score: null,
      avatar_url: null,
      followers: null,
      trades_count: null,
      copiers: null,
      is_bot: false,
      trader_type: null,
      anti_gaming_flags: [],
    }
    expect(tradersResponseSchema.safeParse({ ...baseResponse, traders: [row] }).success).toBe(true)
  })
})
