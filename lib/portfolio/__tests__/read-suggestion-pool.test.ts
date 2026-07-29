const mockGetLeaderboard = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'
import { readSealedPortfolioSuggestionPool } from '@/lib/portfolio/read-suggestion-pool'

const COHORT_ID = '11111111-1111-4111-8111-111111111111'
const DYNAMIC_AUTHORITY_SOURCES = ['binance_futures', 'gtrade']

describe('readSealedPortfolioSuggestionPool', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetLeaderboard.mockResolvedValue({
      traders: [{ traderKey: 'trader-1' }],
      total: 1,
    })
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _client: unknown,
        _season: unknown,
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string }>
        }) => Promise<unknown>
      ) => ({
        value: await reader({
          scoreCohortId: COHORT_ID,
          proofs: DYNAMIC_AUTHORITY_SOURCES.map((source) => ({ source })),
        }),
      })
    )
  })

  it('binds the complete candidate pool to one public sealed generation', async () => {
    const supabase = {} as never

    await expect(readSealedPortfolioSuggestionPool(supabase)).resolves.toEqual([
      { traderKey: 'trader-1' },
    ])
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      supabase,
      '90D',
      expect.any(Function),
      { timeoutMs: 15_000 }
    )
    expect(mockGetLeaderboard).toHaveBeenCalledWith(supabase, {
      period: '90D',
      limit: 200,
      sortBy: 'roi',
      excludeOutliers: true,
      scoreCohortId: COHORT_ID,
      allowedSources: DYNAMIC_AUTHORITY_SOURCES,
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
