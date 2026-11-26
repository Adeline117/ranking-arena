jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: jest.fn(async (_key: string, fetcher: () => Promise<unknown>) => fetcher()),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { fetchSimilarTraders } from '../similar'

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'similar-1',
    season_id: '90D',
    rank: 2,
    arena_score: 88,
    roi: 10,
    pnl: 4000,
    win_rate: 60,
    max_drawdown: 8,
    followers: 10,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function query(response: { data: unknown[] | null; error: { message: string } | null }) {
  const result: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of [
    'select',
    'eq',
    'neq',
    'not',
    'gte',
    'lte',
    'order',
    'limit',
    'abortSignal',
  ]) {
    result[method] = jest.fn(() => result)
  }
  result.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return result
}

describe('similar trader public ranking cohort', () => {
  it('reads comparable rank rows from the sealed view and not the raw table', async () => {
    const rankingQuery = query({ data: [row()], error: null })
    const supabase = { from: jest.fn(() => rankingQuery) }

    const result = await fetchSimilarTraders(
      supabase as never,
      'binance_futures',
      'current-trader',
      90,
      null
    )

    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    // Best-effort card: the query is bounded so it cannot stall the profile SSR.
    expect(rankingQuery.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ traderKey: 'similar-1', rank: 2, arenaScore: 88, roi: 10 })
  })

  it('lists nothing when the only candidate fails the proof', async () => {
    const rankingQuery = query({ data: [row({ metrics_estimated: true })], error: null })
    const result = await fetchSimilarTraders(
      { from: jest.fn(() => rankingQuery) } as never,
      'binance_futures',
      'current-trader',
      90,
      null
    )

    expect(result).toEqual([])
  })

  it('drops only the row that fails the proof and still lists the others', async () => {
    const rankingQuery = query({
      data: [
        row({ source_trader_id: 'ok-1', rank: 2 }),
        row({ source_trader_id: 'estimated', rank: 3, metrics_estimated: true }),
        // A published row without win rate / drawdown is a valid neighbour.
        row({
          source_trader_id: 'no-risk-metrics',
          rank: 4,
          win_rate: null,
          max_drawdown: null,
          score_completeness: 'minimal',
        }),
      ],
      error: null,
    })
    const result = await fetchSimilarTraders(
      { from: jest.fn(() => rankingQuery) } as never,
      'binance_futures',
      'current-trader',
      90,
      null
    )

    expect(result.map((trader) => trader.traderKey)).toEqual(['ok-1', 'no-risk-metrics'])
    expect(result[1]).toMatchObject({ winRate: null, maxDrawdown: null })
  })

  it('does not replay a cached recommendation slice after its current proof disappears', async () => {
    const from = jest
      .fn()
      .mockReturnValueOnce(query({ data: [row()], error: null }))
      .mockReturnValueOnce(query({ data: [], error: null }))
    const supabase = { from }

    const first = await fetchSimilarTraders(
      supabase as never,
      'binance_futures',
      'current-trader',
      90,
      null
    )
    const second = await fetchSimilarTraders(
      supabase as never,
      'binance_futures',
      'current-trader',
      90,
      null
    )

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(from).toHaveBeenCalledTimes(2)
  })
})
