import {
  PUBLIC_RANKING_CACHE_EPOCH,
  PUBLIC_RANKING_FUTURE_TOLERANCE_MS,
  PUBLIC_RANKING_MAX_COMPUTED_AGE_MS,
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  PUBLIC_RANKING_REDIS_TAG,
  PUBLIC_RANKING_SOURCE_QUARANTINES,
  filterPublicRankingRows,
  filterPublicRankingSources,
  hasActivePublicRankingQuarantine,
  isPublicRankingRowEligible,
  isPublicRankingSourceAllowed,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  publicRankingCountFromCache,
  sanitizePublicRankingPayload,
  sanitizePublicRankingSourcePayload,
} from '../publication-policy'

function eligibleRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'safe-trader',
    season_id: '90D',
    arena_score: 88,
    roi: 20,
    pnl: 1000,
    win_rate: 60,
    max_drawdown: 10,
    score_completeness: 'full',
    metrics_estimated: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('public ranking publication policy', () => {
  it('binds the cache epoch to the current ranking-authority contract', () => {
    expect(PUBLIC_RANKING_CACHE_EPOCH).toBe('public-rank-policy-v8')
    expect(PUBLIC_RANKING_REDIS_TAG).toBe('rankings:public-rank-policy-v8')
    expect(PUBLIC_RANKING_MAX_COMPUTED_AGE_MS).toBe(48 * 60 * 60 * 1000)
    expect(PUBLIC_RANKING_FUTURE_TOLERANCE_MS).toBe(5 * 60 * 1000)
    expect(PUBLIC_RANKING_SOURCE_QUARANTINES).toEqual([
      {
        source: 'okx_web3_solana',
        contract: 'okx-web3-ranking-quarantine@1',
        reason: 'population_and_window_authority_unverified',
        reviewedAt: '2026-07-24',
      },
      {
        source: 'bitget_bots_futures',
        contract: 'bitget-bot-cumulative-rank-quarantine@1',
        reason: 'inception_cumulative_metrics_are_not_window_rank_authority',
        reviewedAt: '2026-07-28',
      },
      {
        source: 'bitget_bots_spot',
        contract: 'bitget-bot-cumulative-rank-quarantine@1',
        reason: 'inception_cumulative_metrics_are_not_window_rank_authority',
        reviewedAt: '2026-07-28',
      },
      {
        source: 'bingx',
        contract: 'bingx-ranking-quarantine@1',
        reason: 'population_window_and_history_authority_unverified',
        reviewedAt: '2026-08-03',
      },
      {
        source: 'bingx_spot',
        contract: 'bingx-ranking-quarantine@1',
        reason: 'population_window_and_history_authority_unverified',
        reviewedAt: '2026-08-03',
      },
    ])
    expect(PUBLIC_RANKING_QUARANTINED_SOURCES).toEqual([
      'okx_web3_solana',
      'bitget_bots_futures',
      'bitget_bots_spot',
      'bingx',
      'bingx_spot',
    ])
    expect(PUBLIC_RANKING_POSTGREST_EXCLUSION).toBe(
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot,bingx,bingx_spot)'
    )
    expect(hasActivePublicRankingQuarantine()).toBe(true)
  })

  it('normalizes exact source identifiers and fails closed on missing identity', () => {
    expect(isPublicRankingSourceQuarantined(' OKX_WEB3_SOLANA ')).toBe(true)
    expect(isPublicRankingSourceQuarantined(' BITGET_BOTS_FUTURES ')).toBe(true)
    expect(isPublicRankingSourceQuarantined('bitget_bots_spot')).toBe(true)
    expect(isPublicRankingSourceQuarantined(' BINGX ')).toBe(true)
    expect(isPublicRankingSourceQuarantined('bingx_spot')).toBe(true)
    expect(isPublicRankingSourceAllowed('okx_web3_solana')).toBe(false)
    expect(isPublicRankingSourceAllowed('bingx')).toBe(false)
    expect(isPublicRankingSourceAllowed('bingx_spot')).toBe(false)
    expect(isPublicRankingSourceAllowed('binance_futures')).toBe(true)
    expect(isPublicRankingSourceAllowed(' BINANCE_FUTURES ')).toBe(false)
    expect(isPublicRankingSourceAllowed('BINANCE_FUTURES')).toBe(false)
    expect(isPublicRankingSourceAllowed('toobit')).toBe(false)
    expect(isPublicRankingSourceAllowed('okx')).toBe(false)
    expect(isPublicRankingSourceAllowed('')).toBe(false)
    expect(isPublicRankingSourceAllowed(null)).toBe(false)
  })

  it('filters rows and canonicalizes source metadata deterministically', () => {
    const safeRows = filterPublicRankingRows(
      [
        { source: 'binance_futures', id: 1 },
        { source: 'okx_web3_solana', id: 2 },
        { source: 'hyperliquid', id: 3 },
        { source: 'bitget_bots_futures', id: 4 },
        { source: 'bitget_bots_spot', id: 5 },
        { source: 'bingx', id: 6 },
        { source: 'bingx_spot', id: 7 },
      ],
      (row) => row.source
    )
    expect(safeRows.map(({ id }) => id)).toEqual([1, 3])
    expect(
      filterPublicRankingSources([
        'okx_web3_solana',
        'bitget_bots_futures',
        'bitget_bots_spot',
        'bingx',
        'bingx_spot',
        'hyperliquid',
        'binance_futures',
        'hyperliquid',
        ' HYPERLIQUID ',
        'toobit',
        'okx',
        null,
      ])
    ).toEqual(['binance_futures', 'hyperliquid'])
  })

  it('source-only sanitation keeps every safe row in a finite page without requiring proof', () => {
    const first = { source: 'binance_futures', id: 'first' }
    const blocked = { source: 'okx_web3_solana', id: 'blocked' }
    const last = { platform: 'hyperliquid', id: 'last' }
    const payload = {
      traders: [first, blocked, last],
      total: 300,
      totalCount: 300,
      hasMore: true,
      nextCursor: 100,
      availableSources: ['binance_futures', 'okx_web3_solana', 'hyperliquid'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'okx_web3_solana', updated_at: 'blocked' },
        { source: 'hyperliquid', updated_at: 'safe' },
      ],
      meta: {
        total_count: 300,
        has_more: true,
        next_cursor: 'blocked-cursor',
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
        ],
      },
    }

    const sanitized = sanitizePublicRankingSourcePayload(payload)

    expect(sanitized.traders).toEqual([first, last])
    expect(sanitized.availableSources).toEqual(['binance_futures', 'hyperliquid'])
    expect(sanitized.source_freshness.map(({ source }) => source)).toEqual([
      'binance_futures',
      'hyperliquid',
    ])
    expect(sanitized.meta.source_freshness).toEqual([
      { source: 'binance_futures', updated_at: 'safe' },
    ])
    expect(sanitized).toEqual(
      expect.objectContaining({
        total: 2,
        totalCount: 2,
        hasMore: false,
        nextCursor: null,
        ranking_visibility_reasons: ['quarantined_source_removed'],
      })
    )
    expect(sanitized.meta).toEqual(
      expect.objectContaining({ total_count: 2, has_more: false, next_cursor: null })
    )
  })

  it('source-only sanitation preserves a safe incomplete page by identity', () => {
    const payload = {
      rankings: [{ source: 'binance_futures', id: 'no-row-proof' }],
      total_count: 999,
      has_more: true,
      cursor: 'safe-cursor',
      available_sources: ['binance_futures'],
    }

    expect(sanitizePublicRankingSourcePayload(payload)).toBe(payload)
  })

  it('source-only sanitation removes retired rows and metadata from cached pages', () => {
    const safe = { source: 'binance_futures', id: 'safe' }
    const payload = {
      traders: [safe, { source: 'toobit', id: 'retired' }],
      totalCount: 2,
      hasMore: true,
      availableSources: ['binance_futures', 'toobit'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'toobit', updated_at: 'retired' },
      ],
    }

    expect(sanitizePublicRankingSourcePayload(payload)).toEqual(
      expect.objectContaining({
        traders: [safe],
        totalCount: 1,
        hasMore: false,
        availableSources: ['binance_futures'],
        source_freshness: [{ source: 'binance_futures', updated_at: 'safe' }],
        ranking_visibility_reasons: ['inactive_source_removed'],
      })
    )
  })

  it('filters quarantined cached metadata without clearing correct page totals or cursors', () => {
    const safeTrader = { source: 'binance_futures', id: 'safe-without-proof' }
    const payload = {
      traders: [safeTrader],
      totalCount: 321,
      hasMore: true,
      nextCursor: 50,
      as_of: 'blocked-aggregate-watermark',
      is_stale: false,
      availableSources: ['binance_futures', 'okx_web3_solana'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'okx_web3_solana', updated_at: 'blocked' },
      ],
      meta: {
        total_count: 321,
        has_more: true,
        next_cursor: 'safe-cursor',
        updated_at: 'blocked-aggregate-watermark',
        staleness_seconds: 1,
        is_stale: false,
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
        ],
      },
    }

    const sanitized = sanitizePublicRankingSourcePayload(payload)

    expect(sanitized.traders).toEqual([safeTrader])
    expect(sanitized).toEqual(
      expect.objectContaining({
        totalCount: 321,
        hasMore: true,
        nextCursor: 50,
        as_of: null,
        is_stale: true,
      })
    )
    expect(sanitized.meta).toEqual(
      expect.objectContaining({
        total_count: 321,
        has_more: true,
        next_cursor: 'safe-cursor',
        updated_at: null,
        staleness_seconds: null,
        is_stale: true,
      })
    )
    expect(sanitized.availableSources).toEqual(['binance_futures'])
    expect(sanitized.source_freshness).toEqual([{ source: 'binance_futures', updated_at: 'safe' }])
    expect(sanitized.meta.source_freshness).toEqual([
      { source: 'binance_futures', updated_at: 'safe' },
    ])
  })

  it('uses only active public sources from the atomic count generation', () => {
    const generation = '2026-07-24T12:00:00.000Z'
    const rows = [
      { source: '_all_gt0', total_count: 18, updated_at: generation },
      { source: 'binance_futures_gt0', total_count: 10, updated_at: generation },
      { source: 'hyperliquid_gt0', total_count: 5, updated_at: generation },
      { source: 'okx_web3_solana_gt0', total_count: 3, updated_at: generation },
    ]

    expect(publicRankingCountFromCache(rows)).toBe(15)
    expect(publicRankingCountFromCache(rows, { source: 'binance_futures' })).toBe(10)
    expect(publicRankingCountFromCache(rows, { source: 'okx_web3_solana' })).toBe(0)
    expect(publicRankingCountFromCache(rows, { source: 'toobit' })).toBe(0)
    expect(publicRankingCountFromCache(rows, { sources: ['binance_futures', 'hyperliquid'] })).toBe(
      15
    )
    expect(
      publicRankingCountFromCache([
        ...rows.slice(0, 3),
        {
          source: 'okx_web3_solana_gt0',
          total_count: 99,
          updated_at: 'stale-generation',
        },
      ])
    ).toBe(15)
    expect(
      publicRankingCountFromCache([
        ...rows.slice(0, 3),
        {
          source: 'okx_web3_solana_gt0',
          total_count: Number.NaN,
          updated_at: generation,
        },
      ])
    ).toBe(15)
    expect(
      publicRankingCountFromCache([
        rows[0],
        rows[1],
        { ...rows[2], total_count: Number.NaN },
        rows[3],
      ])
    ).toBeNull()
    expect(publicRankingCountFromCache(rows.slice(1))).toBeNull()
  })

  it('epochs ordinary public ranking cache keys', () => {
    expect(publicRankingCacheKey('leaderboard:v3:90D')).toBe(
      'public-rank-policy-v8:leaderboard:v3:90D'
    )
  })

  it('accepts a ranked row without win rate or drawdown and keeps the page complete', () => {
    const nowMs = Date.parse('2026-07-24T12:00:00.000Z')
    const computed_at = '2026-07-24T11:00:00.000Z'
    const rows = [
      eligibleRow({ computed_at }),
      eligibleRow({
        source_trader_id: 'no-win-rate',
        win_rate: null,
        score_completeness: 'partial',
        computed_at,
      }),
      eligibleRow({
        source_trader_id: 'no-drawdown',
        max_drawdown: null,
        score_completeness: 'partial',
        computed_at,
      }),
      eligibleRow({
        source_trader_id: 'roi-pnl-only',
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'minimal',
        computed_at,
      }),
      // A losing trader at the display floor.
      eligibleRow({
        source_trader_id: 'loser',
        roi: -42,
        pnl: -900,
        arena_score: 0.01,
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'minimal',
        computed_at,
      }),
      // 0 is a value: this row is complete.
      eligibleRow({ source_trader_id: 'zeros', win_rate: 0, max_drawdown: 0, computed_at }),
      // Camel-case API shape with the optional keys absent.
      {
        platform: 'binance_futures',
        traderKey: 'api-shape',
        period: '90D',
        arenaScore: 12,
        roi: 3,
        pnl: 40,
        scoreConfidence: 'minimal',
        metricsEstimated: false,
        lastUpdated: computed_at,
      },
    ]
    for (const row of rows) {
      expect(isPublicRankingRowEligible(row, { expectedPeriod: '90D', nowMs })).toBe(true)
    }

    const payload = { period: '90D', traders: rows, totalCount: 9000, hasMore: true }
    const sanitized = sanitizePublicRankingPayload(payload, { nowMs })
    // Nothing is removed, so totals and pagination are not downgraded.
    expect(sanitized.traders).toHaveLength(rows.length)
    expect(sanitized).toEqual(expect.objectContaining({ totalCount: 9000, hasMore: true }))
    expect(sanitized).not.toHaveProperty('ranking_visibility')
  })

  it('rejects a completeness label that disagrees with the metrics the row carries', () => {
    const nowMs = Date.parse('2026-07-24T12:00:00.000Z')
    const computed_at = '2026-07-24T11:00:00.000Z'
    for (const ineligible of [
      eligibleRow({ win_rate: null, computed_at }), // says full
      eligibleRow({ max_drawdown: null, computed_at }), // says full
      eligibleRow({ score_completeness: 'minimal', computed_at }), // has both
      eligibleRow({ win_rate: 0, max_drawdown: null, score_completeness: 'minimal', computed_at }),
      eligibleRow({
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'partial',
        computed_at,
      }),
      eligibleRow({ score_completeness: 'weird', computed_at }),
      eligibleRow({ score_completeness: null, computed_at }),
      // ROI and PnL stay mandatory whatever the label says.
      eligibleRow({
        roi: null,
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'minimal',
        computed_at,
      }),
      eligibleRow({
        pnl: null,
        win_rate: null,
        max_drawdown: null,
        score_completeness: 'minimal',
        computed_at,
      }),
      // Estimated and outlier rows stay out.
      eligibleRow({
        metrics_estimated: true,
        win_rate: null,
        score_completeness: 'partial',
        computed_at,
      }),
      eligibleRow({ is_outlier: true, win_rate: null, score_completeness: 'partial', computed_at }),
      // A present optional metric must still be a real in-range number.
      eligibleRow({ win_rate: '60', computed_at }),
      eligibleRow({ win_rate: -0.01, computed_at }),
      eligibleRow({ max_drawdown: -1, computed_at }),
      eligibleRow({ max_drawdown: 100, computed_at }),
      // Score domain is (0, 100]: 0 still means "not scored".
      eligibleRow({ arena_score: 0, win_rate: null, score_completeness: 'partial', computed_at }),
    ]) {
      expect(isPublicRankingRowEligible(ineligible, { expectedPeriod: '90D', nowMs })).toBe(false)
    }
  })

  it('requires concrete, consistent, fresh metrics for row-level rank eligibility', () => {
    const nowMs = Date.parse('2026-07-24T12:00:00.000Z')
    const full = eligibleRow({ computed_at: '2026-07-24T11:00:00.000Z' })
    expect(isPublicRankingRowEligible(full, { expectedPeriod: '90D', nowMs })).toBe(true)

    for (const ineligible of [
      eligibleRow({ score_completeness: 'partial', computed_at: full.computed_at }),
      eligibleRow({ metrics_estimated: true, computed_at: full.computed_at }),
      eligibleRow({ is_outlier: true, computed_at: full.computed_at }),
      eligibleRow({ pnl: null, computed_at: full.computed_at }),
      eligibleRow({ win_rate: Number.NaN, computed_at: full.computed_at }),
      eligibleRow({ arena_score: 101, computed_at: full.computed_at }),
      eligibleRow({ win_rate: 101, computed_at: full.computed_at }),
      eligibleRow({ max_drawdown: 100, computed_at: full.computed_at }),
      eligibleRow({ source_trader_id: ' ', computed_at: full.computed_at }),
      eligibleRow({ source: ' HYPERLIQUID ', computed_at: full.computed_at }),
      eligibleRow({ source: 'HYPERLIQUID', computed_at: full.computed_at }),
      eligibleRow({ platform: 'okx_web3_solana', computed_at: full.computed_at }),
      eligibleRow({ trader_key: 'different', computed_at: full.computed_at }),
      eligibleRow({ computed_at: '2026-07-22T11:59:59.999Z' }),
      eligibleRow({ computed_at: '2026-07-24T12:05:00.001Z' }),
      eligibleRow({ computed_at: '2026-07-24' }),
      eligibleRow({ season_id: '30D', computed_at: full.computed_at }),
      eligibleRow({ period: '30D', computed_at: full.computed_at }),
    ]) {
      expect(isPublicRankingRowEligible(ineligible, { expectedPeriod: '90D', nowMs })).toBe(false)
    }
    expect(isPublicRankingRowEligible(full, { nowMs: Number.NaN })).toBe(false)
    expect(
      isPublicRankingRowEligible(eligibleRow({ season_id: undefined }), {
        expectedPeriod: '',
        nowMs,
      })
    ).toBe(false)
    expect(isPublicRankingRowEligible(full, { expectedPeriod: ' 90D ', nowMs })).toBe(false)
  })

  it('sanitizes a polluted cached payload and marks totals as a partial lower bound', () => {
    const safeTrader = eligibleRow({ id: 1 })
    const payload = {
      period: '90D',
      traders: [
        safeTrader,
        eligibleRow({ source: 'okx_web3_solana', source_trader_id: 'blocked', id: 2 }),
      ],
      availableSources: ['binance_futures', 'okx_web3_solana'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'okx_web3_solana', updated_at: 'unsafe' },
      ],
      total: 4000,
      totalCount: 4000,
      total_count: 4000,
      totalcount: 4000,
      hasMore: true,
      next_cursor: 'unsafe-cursor',
      nextCursor: 55,
    }

    const sanitized = sanitizePublicRankingPayload(payload)

    expect(sanitized).not.toBe(payload)
    expect(sanitized.traders).toEqual([safeTrader])
    expect(sanitized.availableSources).toEqual(['binance_futures'])
    expect(sanitized.source_freshness).toEqual([{ source: 'binance_futures', updated_at: 'safe' }])
    expect(sanitized).toEqual(
      expect.objectContaining({
        total: 1,
        totalCount: 1,
        total_count: 1,
        totalcount: 1,
        hasMore: false,
        next_cursor: null,
        nextCursor: null,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
        ranking_visibility_reasons: ['quarantined_source_removed'],
      })
    )
    expect(payload.traders).toHaveLength(2)
  })

  it('supports platform-shaped rows and preserves already-safe payload identity', () => {
    const platformTrader = eligibleRow({
      source: undefined,
      platform: 'hyperliquid',
      source_trader_id: undefined,
      traderKey: 'safe-platform-trader',
    })
    const polluted = sanitizePublicRankingPayload({
      period: '90D',
      traders: [
        eligibleRow({
          source: undefined,
          platform: 'okx_web3_solana',
          source_trader_id: undefined,
          traderKey: 'blocked-platform-trader',
        }),
        platformTrader,
      ],
      totalCount: 2,
    })
    expect(polluted.traders).toEqual([platformTrader])

    const safe = {
      period: '90D',
      traders: [eligibleRow({ source: 'hyperliquid' })],
      totalCount: 10,
    }
    expect(sanitizePublicRankingPayload(safe)).toBe(safe)
  })

  it('removes mislabeled or unknown rows even when their source is otherwise allowed', () => {
    const safeTrader = eligibleRow({ source: 'hyperliquid', source_trader_id: 'full' })
    const sanitized = sanitizePublicRankingPayload({
      period: '90D',
      traders: [
        safeTrader,
        eligibleRow({
          source: 'hyperliquid',
          source_trader_id: 'partial',
          score_completeness: 'partial',
        }),
        eligibleRow({
          source: 'binance_futures',
          source_trader_id: 'estimated',
          metrics_estimated: true,
        }),
        eligibleRow({ source: 'binance_futures', source_trader_id: 'unknown-cost', pnl: null }),
      ],
      totalCount: 4,
      hasMore: true,
    })

    expect(sanitized.traders).toEqual([safeTrader])
    expect(sanitized).toEqual(
      expect.objectContaining({
        totalCount: 1,
        hasMore: false,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
        ranking_visibility_reasons: ['ineligible_ranking_row_removed'],
      })
    )
  })

  it('binds real route-shaped proof rows to the payload period and never trusts id alone', () => {
    const routeRow = eligibleRow({ id: 'public-id', source_trader_id: 'source-id' })
    const crossPeriod = eligibleRow({
      id: 'other-period',
      source_trader_id: 'other-source-id',
      season_id: '30D',
    })
    const idOnly = {
      id: 'ambiguous-id',
      source: 'hyperliquid',
      arena_score: 80,
      roi: 10,
      pnl: 100,
      win_rate: 55,
      max_drawdown: 12,
      score_completeness: 'full',
      metrics_estimated: false,
      computed_at: new Date().toISOString(),
      season_id: '90D',
    }

    const sanitized = sanitizePublicRankingPayload({
      period: '90D',
      traders: [routeRow, crossPeriod, idOnly],
      totalCount: 3,
    })

    expect(sanitized.traders).toEqual([routeRow])
    expect(sanitized.totalCount).toBe(1)
    expect(sanitized.ranking_visibility_reasons).toEqual(['ineligible_ranking_row_removed'])

    const explicit = { traders: [routeRow], totalCount: 1 }
    expect(sanitizePublicRankingPayload(explicit, { expectedPeriod: '90D' })).toBe(explicit)
    expect(
      sanitizePublicRankingPayload(
        { period: '90D', traders: [routeRow], totalCount: 1 },
        { expectedPeriod: ' 90D ' }
      ).traders
    ).toEqual([])
  })

  it('does not rewrite totals or pagination when only source metadata is quarantined', () => {
    const payload = {
      availableSources: ['binance_futures', 'okx_web3_solana'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        null,
        'malformed',
        { platform: 'hyperliquid', updated_at: 'missing-source' },
        { source: 'okx_web3_solana', updated_at: 'unsafe' },
      ],
      totalCount: 4321,
      hasMore: true,
      nextCursor: 200,
    }

    expect(sanitizePublicRankingPayload(payload)).toEqual({
      availableSources: ['binance_futures'],
      source_freshness: [{ source: 'binance_futures', updated_at: 'safe' }],
      totalCount: 4321,
      hasMore: true,
      nextCursor: 200,
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'publication_policy_filtered',
      ranking_visibility_reasons: ['quarantined_source_removed'],
    })
  })
})
