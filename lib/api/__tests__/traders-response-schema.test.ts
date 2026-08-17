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
})
