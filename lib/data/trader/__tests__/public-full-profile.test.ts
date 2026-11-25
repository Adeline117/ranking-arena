import {
  fetchPublicFullTraderIdentity,
  projectPublicFullProfileRanking,
  sanitizePublicFullPortfolio,
  sanitizePublicFullSimilarTraders,
} from '../public-full-profile'
import { sanitizePublicProfileRankingRows } from '../public-profile-ranking'

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
    rank: 4,
    arena_score: 88,
    arena_score_v3: 87,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 9,
    trades_count: 42,
    followers: 12,
    copiers: 7,
    profitability_score: 20,
    risk_control_score: 18,
    execution_score: 16,
    sharpe_ratio: 1.8,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function identityQuery(response: { data: unknown[] | null; error: { message: string } | null }) {
  const query: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'limit']) {
    query[method] = jest.fn(() => query)
  }
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return query
}

describe('legacy user-full public ranking projection', () => {
  it('resolves the current source identity without a raw-rank tie breaker or cache', async () => {
    const query = identityQuery({
      data: [
        {
          source: 'binance_futures',
          source_trader_id: 'trader-1',
          handle: 'alice',
          avatar_url: 'https://example.test/a.png',
        },
      ],
      error: null,
    })
    const supabase = { from: jest.fn(() => query) }

    await expect(fetchPublicFullTraderIdentity(supabase, 'alice')).resolves.toEqual({
      identity: {
        source: 'binance_futures',
        id: 'trader-1',
        handle: 'alice',
        avatarUrl: 'https://example.test/a.png',
      },
      reason: null,
    })
    expect(supabase.from).toHaveBeenCalledWith('trader_sources')
    expect(query.eq).toHaveBeenCalledWith('handle', 'alice')
    expect(query.eq).not.toHaveBeenCalledWith('source_trader_id', 'alice')
  })

  it('fails a duplicate handle closed instead of using rank data to pick an identity', async () => {
    const query = identityQuery({
      data: [
        {
          source: 'binance_futures',
          source_trader_id: 'trader-1',
          handle: 'alice',
          avatar_url: null,
        },
        { source: 'bybit', source_trader_id: 'trader-2', handle: 'alice', avatar_url: null },
      ],
      error: null,
    })

    await expect(
      fetchPublicFullTraderIdentity({ from: jest.fn(() => query) }, 'alice')
    ).resolves.toEqual({
      identity: null,
      reason: 'trader_identity_ambiguous',
    })
  })

  it('preserves only explicit sealed-view period values without filling a missing window', () => {
    const cohort = sanitizePublicProfileRankingRows(
      [row({ season_id: '30D', roi: 8, pnl: 900 })],
      SCOPE
    )

    const result = projectPublicFullProfileRanking(cohort)

    expect(result.rankingVisibility).toBe('partial')
    expect(result.performance).toMatchObject({
      roi_90d: null,
      pnl: null,
      rank: null,
      roi_30d: 8,
      pnl_30d: 900,
      rank_30d: 4,
      overall_score: null,
      score_penalty: null,
    })
    expect(result.stats).toBeNull()
    expect(result.followers90D).toBeNull()
  })

  it('collapses unproven core metrics to unknown instead of a zero-valued performance object', () => {
    const cohort = sanitizePublicProfileRankingRows([row({ metrics_estimated: true })], SCOPE)

    expect(projectPublicFullProfileRanking(cohort)).toMatchObject({
      performance: null,
      stats: null,
      rank90D: null,
      arenaScore90D: null,
      roi90D: null,
      followers90D: null,
      copiers90D: null,
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    })
  })

  it('keeps raw position PnL, value, and price unknown while retaining non-ranking position facts', () => {
    expect(
      sanitizePublicFullPortfolio([
        {
          market: 'BTCUSDT',
          direction: 'long',
          invested: 25,
          pnl: 9999,
          value: 12345,
          price: 100000,
        },
      ])
    ).toEqual([
      {
        market: 'BTCUSDT',
        direction: 'long',
        invested: 25,
        pnl: null,
        value: null,
        price: null,
        priceChange: null,
        priceChangePct: null,
        coverage_state: 'unknown',
        coverage_reason: 'position_value_unverified',
      },
    ])
  })

  it('fails the complete similar-trader slice closed when one candidate loses rank proof', () => {
    const valid = {
      platform: SCOPE.source,
      traderKey: 'similar-1',
      handle: 'similar',
      avatarUrl: null,
      followers: 3,
      copiers: 1,
      tradesCount: 10,
      roi: 9,
      pnl: 200,
      winRate: 60,
      maxDrawdown: 8,
      arenaScore: 80,
      rank: 2,
    }

    expect(sanitizePublicFullSimilarTraders([valid], SCOPE.source)).toEqual([
      {
        handle: 'similar',
        id: 'similar-1',
        source: SCOPE.source,
        avatar_url: null,
        followers: 3,
        copiers: 1,
        trades_count: 10,
        roi_90d: 9,
        pnl: 200,
        win_rate: 60,
        max_drawdown: 8,
        arena_score: 80,
        rank: 2,
      },
    ])
    expect(
      sanitizePublicFullSimilarTraders([valid, { ...valid, rank: null }], SCOPE.source)
    ).toEqual([])
  })

  it('keeps the similar-trader slice when a ranked member has no win rate or drawdown', () => {
    const member = (traderKey: string, rank: number, overrides: Record<string, unknown> = {}) => ({
      platform: SCOPE.source,
      traderKey,
      handle: traderKey,
      avatarUrl: null,
      followers: 3,
      copiers: 1,
      tradesCount: 10,
      roi: 9,
      pnl: 200,
      winRate: 60,
      maxDrawdown: 8,
      arenaScore: 80,
      rank,
      ...overrides,
    })

    const slice = sanitizePublicFullSimilarTraders(
      [
        member('full', 2),
        member('no-win-rate', 3, { winRate: null }),
        member('no-drawdown', 4, { maxDrawdown: null }),
        member('roi-pnl-only', 5, { winRate: null, maxDrawdown: null }),
        // 0 is a value, not "missing".
        member('zeros', 6, { winRate: 0, maxDrawdown: 0 }),
        // A losing trader is a ranked trader.
        member('loser', 7, { roi: -40, pnl: -900, arenaScore: 0.01 }),
      ],
      SCOPE.source
    )
    expect(slice.map((row) => [row.id, row.win_rate, row.max_drawdown])).toEqual([
      ['full', 60, 8],
      ['no-win-rate', null, 8],
      ['no-drawdown', 60, null],
      ['roi-pnl-only', null, null],
      ['zeros', 0, 0],
      ['loser', 60, 8],
    ])

    // ROI and PnL stay mandatory, and a present-but-malformed optional metric
    // still fails the slice closed.
    for (const broken of [
      { roi: null },
      { pnl: null },
      { winRate: Number.NaN },
      { winRate: '60' },
      { maxDrawdown: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        sanitizePublicFullSimilarTraders(
          [member('full', 2), member('bad', 3, broken)],
          SCOPE.source
        )
      ).toEqual([])
    }
  })
})
