const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockReadSealedRankingGeneration = jest.fn()

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import { fetchSimilarTraders } from '../similar'

function leaderboardQuery(rows: Array<Record<string, unknown>>) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'filter', 'neq', 'not', 'or', 'gte', 'lte', 'order']) {
    query[method] = jest.fn(() => query)
  }
  query.limit = jest.fn().mockResolvedValue({ data: rows, error: null })
  return query
}

describe('fetchSimilarTraders sealed generation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGet.mockResolvedValue({ data: [{ source_trader_id: 'legacy-cache' }] })
    mockTieredSet.mockResolvedValue(undefined)
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: '90D'; sources: string[] },
        reader: (publication: {
          state: 'sealed'
          season: '90D'
          scoreCohortId: string
          proofs: Array<Record<string, unknown>>
        }) => Promise<unknown>
      ) => {
        const scoreCohortId = '11111111-1111-4111-8111-111111111111'
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId,
          proofs: input.sources.map((source) => ({
            season_id: input.season,
            source,
            source_as_of: '2026-07-29T10:00:00.000000Z',
            recorded_at: '2026-07-29T10:01:00.000000Z',
            score_cohort_id: scoreCohortId,
            rank_mutation_seq: 9,
            current_mutation_seq: 9,
            published_rank_count: 1,
            published_identity_sha256: 'a'.repeat(64),
            is_sealed: true,
          })),
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('rejects a generic cache and binds the database row to the sealed cohort', async () => {
    const query = leaderboardQuery([
      {
        source: 'binance_futures',
        source_trader_id: 'similar-one',
        season_id: '90D',
        arena_score: 82,
        roi: 12,
        rank: 10,
      },
    ])
    const supabase = {
      from: jest.fn(() => query),
    }

    const result = await fetchSimilarTraders(
      supabase as never,
      'binance_futures',
      'current/trader',
      80,
      10
    )

    expect(mockTieredGet).toHaveBeenCalledWith(
      expect.stringContaining('similar:sealed-v2:binance_futures:current%2Ftrader:80'),
      'warm'
    )
    expect(query.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(query.neq).toHaveBeenCalledWith('source_trader_id', 'current/trader')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(
      expect.objectContaining({ platform: 'binance_futures', traderKey: 'similar-one' })
    )
    expect(mockTieredSet).toHaveBeenCalledWith(
      expect.stringContaining('similar:sealed-v2'),
      expect.objectContaining({
        contract: 'sealed-ranking-cache@1',
        value: expect.any(Array),
      }),
      'warm',
      ['similar-traders']
    )
  })
})
