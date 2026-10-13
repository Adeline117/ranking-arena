import {
  fetchPublicProfileRankingRows,
  sanitizePublicProfileRankingRows,
} from '../public-profile-ranking'

const SCOPE = {
  source: 'binance_futures',
  sourceTraderId: 'trader-1',
  periods: ['7D', '30D', '90D'] as const,
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: SCOPE.source,
    source_trader_id: SCOPE.sourceTraderId,
    season_id: '90D',
    rank: 1,
    arena_score: 88,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 9,
    trades_count: 42,
    followers: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function query(response: { data: unknown[] | null; error: { message: string } | null }) {
  const result: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'in', 'not', 'abortSignal']) {
    result[method] = jest.fn(() => result)
  }
  result.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return result
}

describe('public trader-profile ranking cohort', () => {
  it('reads one exact identity from the sealed view before exposing its rank fields', async () => {
    const rankingQuery = query({ data: [row()], error: null })
    const supabase = { from: jest.fn(() => rankingQuery) }

    const result = await fetchPublicProfileRankingRows(supabase, {
      ...SCOPE,
      periods: ['90D'],
    })

    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(rankingQuery.eq).toHaveBeenNthCalledWith(1, 'source', SCOPE.source)
    expect(rankingQuery.eq).toHaveBeenNthCalledWith(2, 'source_trader_id', SCOPE.sourceTraderId)
    expect(rankingQuery.in).toHaveBeenCalledWith('season_id', ['90D'])
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(result).toMatchObject({
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
      rows: [expect.objectContaining({ season_id: '90D', rank: 1, roi: 12.5 })],
    })
  })

  it('fails the whole profile ranking cohort when a view response cannot prove its inputs', () => {
    const result = sanitizePublicProfileRankingRows([row({ metrics_estimated: true })], {
      ...SCOPE,
      periods: ['90D'],
    })

    expect(result).toEqual({
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    })
  })

  it('keeps a published 90D row but marks omitted requested periods partial', () => {
    const result = sanitizePublicProfileRankingRows([row()], SCOPE)

    expect(result.rankingVisibility).toBe('partial')
    expect(result.rankingVisibilityReason).toBe('public_period_not_published')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ season_id: '90D', rank: 1 })
  })

  it('reports an empty sealed-view result as unknown rather than a zero rank', () => {
    expect(sanitizePublicProfileRankingRows([], { ...SCOPE, periods: ['90D'] })).toEqual({
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    })
  })

  it('does not query a source outside the public ranking contract', async () => {
    const from = jest.fn()
    const result = await fetchPublicProfileRankingRows(
      { from },
      { ...SCOPE, source: 'okx_web3_solana', periods: ['90D'] }
    )

    expect(from).not.toHaveBeenCalled()
    expect(result).toEqual({
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'source_not_publicly_rankable',
    })
  })

  it('does not turn an unavailable view query into an unranked profile', async () => {
    const rankingQuery = query({ data: null, error: { message: 'database unavailable' } })
    const result = await fetchPublicProfileRankingRows(
      { from: jest.fn(() => rankingQuery) },
      { ...SCOPE, periods: ['90D'] }
    )

    expect(result).toEqual({
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
    })
  })
})
