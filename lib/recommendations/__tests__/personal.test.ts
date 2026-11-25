/**
 * Personal recommendations must use the sealed ranking cohort twice:
 * candidate creation may be cached, but response metrics are always current.
 */

type QueryResult = { data: unknown; error?: unknown }
type QueryChain = Record<string, jest.Mock> & { then: Promise<QueryResult>['then'] }

const mockQueues: Record<string, QueryResult[]> = {}
const queryCalls: Record<string, QueryChain[]> = {}

function makeQuery(result: QueryResult): QueryChain {
  const chain = {} as QueryChain
  for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'neq', 'not', 'gt', 'or', 'order']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.limit = jest.fn(async () => ({ data: result.data, error: result.error ?? null }))
  chain.then = (resolve, reject) =>
    Promise.resolve({ data: result.data, error: result.error ?? null }).then(resolve, reject)
  return chain
}

const mockFrom = jest.fn((table: string) => {
  const result = mockQueues[table]?.shift() ?? { data: [] }
  const query = makeQuery(result)
  ;(queryCalls[table] ??= []).push(query)
  return query
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}))

import {
  getPersonalRecommendationCandidates,
  getPersonalRecommendations,
  materializePersonalRecommendations,
  sanitizePersonalRecommendationCandidates,
} from '../personal'

function ranked(id: string, source = 'bybit', overrides: Record<string, unknown> = {}) {
  return {
    season_id: '90D',
    source,
    source_trader_id: id,
    handle: id,
    avatar_url: null,
    rank: 1,
    arena_score: 80,
    roi: 50,
    pnl: 100,
    win_rate: 60,
    max_drawdown: 12,
    trades_count: 40,
    followers: 10,
    copiers: 2,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function queue(table: string, ...results: QueryResult[]) {
  mockQueues[table] = results
}

beforeEach(() => {
  jest.clearAllMocks()
  for (const table of Object.keys(mockQueues)) delete mockQueues[table]
  for (const table of Object.keys(queryCalls)) delete queryCalls[table]
})

describe('personal recommendation publication boundary', () => {
  it('builds metric-free fallback candidates, then materializes fresh metrics from the public cohort', async () => {
    queue('user_follows', { data: [] })
    queue(
      'public_ranked_leaderboard',
      { data: [ranked('top-1', 'bybit', { arena_score: 80, roi: 50 })] },
      { data: [ranked('top-1', 'bybit', { arena_score: 71, roi: 7, pnl: 17, win_rate: 61 })] }
    )

    const candidates = await getPersonalRecommendationCandidates('u1', 10)
    expect(candidates).toEqual([
      { source: 'bybit', source_trader_id: 'top-1', reason: 'top_performer' },
    ])
    expect(JSON.stringify(candidates)).not.toContain('arena_score')
    expect(JSON.stringify(candidates)).not.toContain('roi')

    const result = await materializePersonalRecommendations(candidates, 10)
    expect(result).toEqual({
      recommendations: [
        expect.objectContaining({
          source: 'bybit',
          source_trader_id: 'top-1',
          arena_score: 71,
          roi: 7,
          pnl: 17,
          win_rate: 61,
          reason: 'top_performer',
        }),
      ],
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
    })
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('materializes a ranked trader that has no win rate instead of failing the cohort', async () => {
    queue('public_ranked_leaderboard', {
      data: [
        ranked('top-1'),
        ranked('no-win-rate', 'bybit', {
          rank: 2,
          win_rate: null,
          score_completeness: 'partial',
        }),
        ranked('roi-pnl-only', 'bybit', {
          rank: 3,
          roi: -9,
          pnl: -40,
          arena_score: 0.01,
          win_rate: null,
          max_drawdown: null,
          score_completeness: 'minimal',
        }),
      ],
    })

    const result = await materializePersonalRecommendations(
      [
        { source: 'bybit', source_trader_id: 'top-1', reason: 'top_performer' },
        { source: 'bybit', source_trader_id: 'no-win-rate', reason: 'top_performer' },
        { source: 'bybit', source_trader_id: 'roi-pnl-only', reason: 'top_performer' },
      ],
      10
    )

    expect(result.rankingVisibility).toBe('verified')
    expect(
      result.recommendations.map((row) => [row.source_trader_id, row.win_rate, row.roi])
    ).toEqual([
      ['top-1', 60, 50],
      ['no-win-rate', null, 50],
      ['roi-pnl-only', null, -9],
    ])
  })

  it('derives similar and preferred-exchange candidates only from verified seed and candidate rows', async () => {
    queue('user_follows', { data: [{ following_id: 'followed-1' }] })
    queue(
      'public_ranked_leaderboard',
      { data: [ranked('followed-1', 'bybit', { roi: 100 })] },
      { data: [ranked('similar-1', 'bybit', { roi: 95 })] },
      { data: [ranked('preferred-1', 'bybit', { roi: 30 })] }
    )

    const candidates = await getPersonalRecommendationCandidates('u1', 10)

    expect(candidates).toEqual([
      {
        source: 'bybit',
        source_trader_id: 'similar-1',
        reason: 'similar_to_follow',
        reference_source: 'bybit',
        reference_trader_id: 'followed-1',
      },
      {
        source: 'bybit',
        source_trader_id: 'preferred-1',
        reason: 'preferred_exchange',
      },
    ])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('uses an ordered negative-ROI range instead of substituting a zero seed ROI', async () => {
    queue('user_follows', { data: [{ following_id: 'followed-1' }] })
    queue(
      'public_ranked_leaderboard',
      { data: [ranked('followed-1', 'bybit', { roi: -10 })] },
      { data: [ranked('similar-1', 'bybit', { roi: -9 })] },
      { data: [] }
    )

    await getPersonalRecommendationCandidates('u1', 10)

    const similarQuery = queryCalls.public_ranked_leaderboard[1]
    expect(similarQuery.gte).toHaveBeenCalledWith('roi', -13)
    expect(similarQuery.lte).toHaveBeenCalledWith('roi', -7)
  })

  it('fails closed when a seed or candidate row does not satisfy the public cohort proof', async () => {
    queue('user_follows', { data: [] })
    queue('public_ranked_leaderboard', {
      data: [ranked('unverified', 'bybit', { metrics_estimated: true })],
    })

    await expect(getPersonalRecommendations('u1', 10)).resolves.toEqual([])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('does not disguise an unverified followed seed as a generic personalization fallback', async () => {
    queue('user_follows', { data: [{ following_id: 'followed-1' }] })
    queue('public_ranked_leaderboard', {
      data: [ranked('followed-1', 'bybit', { metrics_estimated: true })],
    })

    await expect(getPersonalRecommendationCandidates('u1', 10)).resolves.toEqual([])
    expect(queryCalls.public_ranked_leaderboard).toHaveLength(1)
  })

  it('never replays ranking metrics carried by a legacy-shaped candidate cache hit', async () => {
    queue('public_ranked_leaderboard', {
      data: [ranked('current-1', 'bybit', { arena_score: 70, roi: 3, pnl: 4, win_rate: 55 })],
    })
    const legacyCandidate = {
      source: 'bybit',
      source_trader_id: 'current-1',
      reason: 'top_performer',
      arena_score: 999,
      roi: 999,
      pnl: 999,
      win_rate: 999,
      rank: 1,
    }

    const result = await materializePersonalRecommendations([legacyCandidate], 10)

    expect(result.recommendations).toEqual([
      expect.objectContaining({ arena_score: 70, roi: 3, pnl: 4, win_rate: 55 }),
    ])
    expect(JSON.stringify(result)).not.toContain('999')
  })

  it('drops a similar-to-follow cache candidate when its current reference seed is no longer ranked', async () => {
    queue('public_ranked_leaderboard', { data: [ranked('candidate-1', 'bybit')] })

    const result = await materializePersonalRecommendations(
      [
        {
          source: 'bybit',
          source_trader_id: 'candidate-1',
          reason: 'similar_to_follow',
          reference_source: 'bybit',
          reference_trader_id: 'former-seed',
        },
      ],
      10
    )

    expect(result).toEqual({
      recommendations: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'cached_candidate_unverified',
    })
  })

  it('projects cache candidates to identity and reason fields only', () => {
    expect(
      sanitizePersonalRecommendationCandidates([
        {
          source: 'bybit',
          source_trader_id: 'candidate-1',
          reason: 'top_performer',
          arena_score: 100,
          roi: 100,
        },
      ])
    ).toEqual([{ source: 'bybit', source_trader_id: 'candidate-1', reason: 'top_performer' }])
  })
})
