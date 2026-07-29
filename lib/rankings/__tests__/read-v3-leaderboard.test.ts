const mockGetLeaderboard = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { filterPublicRankingSources } from '@/lib/rankings/publication-policy'
import { readV3Leaderboard } from '@/lib/rankings/read-v3-leaderboard'

const COHORT_ID = '11111111-1111-4111-8111-111111111111'

describe('readV3Leaderboard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetLeaderboard.mockResolvedValue({
      traders: [{ traderKey: 'trader-1' }],
      total: 999_999,
    })
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
        input: { season: string; sources: string[] },
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string; published_rank_count: number }>
        }) => Promise<unknown>
      ) => {
        const publication = {
          scoreCohortId: COHORT_ID,
          proofs: input.sources.map((source, index) => ({
            source,
            published_rank_count: index + 1,
          })),
        }
        return { value: await reader(publication) }
      }
    )
  })

  it('binds the all-source API read and total to one sealed proof set', async () => {
    const supabase = {} as never
    const result = await readV3Leaderboard(supabase, {
      period: '90D',
      limit: 50,
      offset: 25,
    })
    const expectedSources = filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '90D', sources: expectedSources },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockGetLeaderboard).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        period: '90D',
        limit: 50,
        offset: 25,
        scoreCohortId: COHORT_ID,
        allowedSources: expectedSources,
      })
    )
    expect(result.traders).toEqual([{ traderKey: 'trader-1' }])
    expect(result.total).toBe((expectedSources.length * (expectedSources.length + 1)) / 2)
  })

  it('uses the exact canonical platform as the proof and SQL source scope', async () => {
    const supabase = {} as never
    const result = await readV3Leaderboard(supabase, {
      platform: 'binance_futures',
      period: '7D',
      limit: 10,
      offset: 0,
    })

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '7D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockGetLeaderboard).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        platform: 'binance_futures',
        scoreCohortId: COHORT_ID,
        allowedSources: ['binance_futures'],
      })
    )
    expect(result.total).toBe(1)
  })

  it('rejects aliases and unknown sources before proof or row reads', async () => {
    await expect(
      readV3Leaderboard({} as never, {
        platform: 'binance',
        period: '90D',
        limit: 10,
        offset: 0,
      })
    ).rejects.toThrow('not a canonical public source')

    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockGetLeaderboard).not.toHaveBeenCalled()
  })

  it('fails closed instead of turning a cohort query error into an empty success', async () => {
    mockGetLeaderboard.mockResolvedValue({ traders: [], total: 0, error: 'database unavailable' })

    await expect(
      readV3Leaderboard({} as never, {
        platform: 'binance_futures',
        period: '30D',
        limit: 10,
        offset: 0,
      })
    ).rejects.toThrow('v3 sealed leaderboard query failed: database unavailable')
  })
})
