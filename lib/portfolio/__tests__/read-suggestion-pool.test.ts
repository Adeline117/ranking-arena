const mockGetLeaderboard = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'
import {
  PORTFOLIO_SUGGESTION_SOURCES,
  readSealedPortfolioSuggestionPool,
} from '@/lib/portfolio/read-suggestion-pool'

const COHORT_ID = '11111111-1111-4111-8111-111111111111'

describe('readSealedPortfolioSuggestionPool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetLeaderboard.mockResolvedValue({
      traders: [{ traderKey: 'trader-1' }],
      total: 1,
    })
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
        _input: unknown,
        reader: (publication: { scoreCohortId: string }) => Promise<unknown>
      ) => ({
        value: await reader({ scoreCohortId: COHORT_ID }),
      })
    )
  })

  it('binds the complete candidate pool to one public sealed generation', async () => {
    const supabase = {} as never

    await expect(readSealedPortfolioSuggestionPool(supabase)).resolves.toEqual([
      { traderKey: 'trader-1' },
    ])
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '90D', sources: PORTFOLIO_SUGGESTION_SOURCES },
      expect.any(Function),
      { timeoutMs: 15_000 }
    )
    expect(mockGetLeaderboard).toHaveBeenCalledWith(supabase, {
      period: '90D',
      limit: 200,
      sortBy: 'roi',
      excludeOutliers: true,
      scoreCohortId: COHORT_ID,
      allowedSources: PORTFOLIO_SUGGESTION_SOURCES,
      excludeSources: PUBLIC_RANKING_QUARANTINED_SOURCES,
    })
  })

  it('fails closed when the cohort-bound candidate query fails', async () => {
    mockGetLeaderboard.mockResolvedValue({
      traders: [],
      total: 0,
      error: 'database unavailable',
    })

    await expect(readSealedPortfolioSuggestionPool({} as never)).rejects.toThrow(
      'sealed portfolio candidate query failed: database unavailable'
    )
  })
})
