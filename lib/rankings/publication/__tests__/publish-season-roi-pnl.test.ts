/**
 * publish-season.test.ts under the 'roi_pnl' rule (the pre-switch test file
 * runs unchanged against the default, 'four_metrics').
 */
process.env.PUBLIC_RANKING_ROW_ELIGIBILITY = 'roi_pnl'

import { createPgRpcClient } from '../pg-rpc-client'
import { encodeColumnarScoreBundle } from '../columnar-score-bundle'
import { SOURCE_PUBLICATION_BUNDLE_RPC } from '../read-source-publication-bundle'
import {
  classifyPublishableRow,
  RANK_PUBLICATION_STAGES,
  rankPublicationReadSplitLine,
  rankPublicationStageTimingLine,
  exclusionAlertDetails,
  fitNumeric,
  publishLeaderboardSeason,
  RankPublicationError,
  toPublishableRow,
  type RankPublicationDatabase,
} from '../publish-season'
import type { RankPublicationSqlExecutor } from '../pg-rpc-client'
import type { ScoredTrader } from '../score-traders'

function scored(overrides: Partial<ScoredTrader> = {}): ScoredTrader {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    source_as_of: '2026-11-12T00:00:00.000000Z',
    arena_score: 71.234,
    arena_score_v3: 60,
    arena_score_v4: 71.234,
    score_factors: null,
    roi: 120.123456,
    pnl: 5000.555,
    win_rate: 61.239,
    max_drawdown: 12.341,
    followers: 3,
    copiers: null,
    trades_count: 40,
    handle: 'h',
    avatar_url: '/logo.png',
    profitability_score: 50,
    risk_control_score: 40,
    execution_score: null,
    score_completeness: 'full',
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: 1.5,
    sortino_ratio: 2,
    profit_factor: 1.2,
    calmar_ratio: 0.8,
    trader_type: null,
    metrics_estimated: false,
    ...overrides,
  }
}

describe('fitNumeric', () => {
  it('rounds to the column scale', () => {
    expect(fitNumeric(123.45678, 10, 4)).toBe(123.4568)
    expect(fitNumeric(1.005, 5, 2)).toBe(1)
  })

  it('returns null when the value cannot be stored in numeric(p,s)', () => {
    expect(fitNumeric(999_999.99995, 10, 4)).toBeNull()
    expect(fitNumeric(1_000_000, 10, 4)).toBeNull()
    expect(fitNumeric(999_999.9999, 10, 4)).toBe(999_999.9999)
    expect(fitNumeric(Number.NaN, 10, 4)).toBeNull()
    expect(fitNumeric(null, 10, 4)).toBeNull()
  })
})

describe('toPublishableRow', () => {
  it('projects onto the persisted codec scales', () => {
    const row = toPublishableRow(scored())
    expect(row).toMatchObject({
      arena_score: 71.23,
      roi: 120.1235,
      pnl: 5000.56,
      win_rate: 61.24,
      max_drawdown: 12.34,
      source_type: expect.any(String),
    })
  })

  it('nulls optional numeric(10,4) ratios that overflow instead of failing the season', () => {
    const row = toPublishableRow(
      scored({ sortino_ratio: 5e6, profit_factor: 1e7, calmar_ratio: -2e6, sharpe_ratio: 1e9 })
    )
    expect(row).not.toBeNull()
    expect(row?.sortino_ratio).toBeNull()
    expect(row?.profit_factor).toBeNull()
    expect(row?.calmar_ratio).toBeNull()
    expect(row?.sharpe_ratio).toBeNull()
  })

  it.each([
    ['estimated metrics', { metrics_estimated: true }],
    ['outlier', { is_outlier: true }],
    ['zero score', { arena_score: 0 }],
    ['score above 100', { arena_score: 100.01 }],
    ['ROI beyond the clamp', { roi: 10000.5 }],
    ['missing ROI', { roi: null as unknown as number }],
    ['missing PnL', { pnl: null }],
    ['negative drawdown', { max_drawdown: -1 }],
    ['unknown completeness label', { score_completeness: 'weird' as never }],
    ['untrimmed identity', { source_trader_id: ' x' }],
    ['non-canonical source', { source: 'Binance' }],
  ])('rejects rows the database seal would refuse: %s', (_label, overrides) => {
    expect(toPublishableRow(scored(overrides))).toBeNull()
  })

  it.each([
    ['partial completeness', { score_completeness: 'partial' as const }],
    ['drawdown of 100%', { max_drawdown: 99.996 }],
    ['missing win rate', { win_rate: null }],
    ['missing drawdown', { max_drawdown: null }],
  ])("'four_metrics' still rejects: %s", (_label, overrides) => {
    expect(toPublishableRow(scored(overrides), 'four_metrics')).toBeNull()
    expect(toPublishableRow(scored(), 'four_metrics')).not.toBeNull()
  })
})

describe("classifyPublishableRow ('roi_pnl': ROI and PnL decide)", () => {
  it.each([
    ['estimated metrics', { metrics_estimated: true }, 'incomplete_or_estimated'],
    ['unknown completeness', { score_completeness: 'weird' as never }, 'incomplete_or_estimated'],
    ['outlier', { is_outlier: true }, 'outlier'],
    ['zero score', { arena_score: 0 }, 'arena_score_out_of_range'],
    ['ROI beyond the clamp', { roi: 10000.5 }, 'roi_out_of_range'],
    ['missing roi', { roi: null as unknown as number }, 'roi_out_of_range'],
    ['missing pnl', { pnl: null as unknown as number }, 'pnl_out_of_range'],
    ['negative drawdown', { max_drawdown: -1 }, 'max_drawdown_negative'],
    ['drawdown below the column', { max_drawdown: -1500 }, 'max_drawdown_negative'],
    ['untrimmed identity', { source_trader_id: ' x' }, 'invalid_identity'],
  ])('names the exclusion reason: %s', (_label, overrides, reason) => {
    expect(classifyPublishableRow(scored(overrides))).toEqual({ reason })
  })

  it('publishes a row without a win rate, with the column empty', () => {
    const verdict = classifyPublishableRow(
      scored({ win_rate: null, score_completeness: 'partial' })
    )
    expect(verdict).toMatchObject({
      row: { win_rate: null, max_drawdown: 12.34, score_completeness: 'partial' },
    })
    expect(verdict).not.toHaveProperty('emptied')
  })

  it('publishes a row without a drawdown, with the column empty', () => {
    expect(
      classifyPublishableRow(scored({ max_drawdown: null, score_completeness: 'partial' }))
    ).toMatchObject({
      row: { win_rate: 61.24, max_drawdown: null, score_completeness: 'partial' },
    })
  })

  it('publishes a row with neither as minimal', () => {
    expect(
      classifyPublishableRow(
        scored({ win_rate: null, max_drawdown: null, score_completeness: 'minimal' })
      )
    ).toMatchObject({ row: { win_rate: null, max_drawdown: null, score_completeness: 'minimal' } })
  })

  it('publishes zero win rate and zero drawdown as values, not as missing', () => {
    expect(classifyPublishableRow(scored({ win_rate: 0, max_drawdown: 0 }))).toMatchObject({
      row: { win_rate: 0, max_drawdown: 0, score_completeness: 'full' },
    })
  })

  it('publishes a losing trader', () => {
    expect(
      classifyPublishableRow(scored({ roi: -35.5, pnl: -1200, arena_score: 0.01 }))
    ).toMatchObject({ row: { roi: -35.5, pnl: -1200, arena_score: 0.01 } })
  })

  it.each([
    ['drawdown rounding to 100%', { max_drawdown: 99.996 }, 'max_drawdown_out_of_range'],
    ['drawdown overflowing numeric(5,2)', { max_drawdown: 1500 }, 'max_drawdown_out_of_range'],
    ['win rate above 100', { win_rate: 100.01 }, 'win_rate_out_of_range'],
    ['negative win rate', { win_rate: -0.5 }, 'win_rate_out_of_range'],
    ['non-finite win rate', { win_rate: Number.NaN }, 'win_rate_out_of_range'],
  ] as const)(
    'empties the metric and keeps the row, with a trace: %s',
    (_label, overrides, trace) => {
      const verdict = classifyPublishableRow(scored(overrides))
      expect(verdict).toMatchObject({ emptied: [trace] })
      const row = 'row' in verdict ? verdict.row : null
      expect(row).not.toBeNull()
      const emptiedColumn = trace === 'win_rate_out_of_range' ? row?.win_rate : row?.max_drawdown
      expect(emptiedColumn).toBeNull()
      // The label follows what is written: the database rejects a mismatch.
      expect(row?.score_completeness).toBe('partial')
    }
  )

  it('derives score_completeness from the written columns, not from the input label', () => {
    expect(
      classifyPublishableRow(scored({ win_rate: null, score_completeness: 'full' }))
    ).toMatchObject({ row: { score_completeness: 'partial' } })
  })

  it('returns the row when every rule passes', () => {
    expect(classifyPublishableRow(scored())).toHaveProperty('row.source', 'binance_futures')
    expect(classifyPublishableRow(scored())).toHaveProperty('row.score_completeness', 'full')
  })
})

describe("classifyPublishableRow ('four_metrics' rollback rule)", () => {
  it.each([
    ['partial completeness', { score_completeness: 'partial' as const }, 'incomplete_or_estimated'],
    ['estimated metrics', { metrics_estimated: true }, 'incomplete_or_estimated'],
    ['outlier', { is_outlier: true }, 'outlier'],
    ['zero score', { arena_score: 0 }, 'arena_score_out_of_range'],
    ['ROI beyond the clamp', { roi: 10000.5 }, 'roi_out_of_range'],
    ['missing pnl', { pnl: null as unknown as number }, 'pnl_out_of_range'],
    ['missing win rate', { win_rate: null }, 'win_rate_missing_or_out_of_range'],
    ['missing drawdown', { max_drawdown: null }, 'max_drawdown_missing'],
    ['drawdown rounding to 100%', { max_drawdown: 99.996 }, 'max_drawdown_liquidated'],
    ['drawdown overflowing numeric(5,2)', { max_drawdown: 1500 }, 'max_drawdown_liquidated'],
    ['negative drawdown', { max_drawdown: -1 }, 'max_drawdown_negative'],
    ['untrimmed identity', { source_trader_id: ' x' }, 'invalid_identity'],
  ])('names the exclusion reason: %s', (_label, overrides, reason) => {
    expect(classifyPublishableRow(scored(overrides), 'four_metrics')).toEqual({ reason })
  })

  it('returns the row when every rule passes', () => {
    expect(classifyPublishableRow(scored(), 'four_metrics')).toHaveProperty(
      'row.source',
      'binance_futures'
    )
  })
})

describe('rankPublicationStageTimingLine', () => {
  it('names the stage, the row count and whole milliseconds', () => {
    expect(RANK_PUBLICATION_STAGES).toEqual(['read', 'score', 'write', 'cleanup', 'rerank', 'seal'])
    expect(rankPublicationStageTimingLine('7D', 'rerank', 9012, 310.4)).toBe(
      '[7D] stage=rerank rows=9012 ms=310'
    )
    expect(rankPublicationStageTimingLine('90D', 'cleanup', 0, -3)).toBe(
      '[90D] stage=cleanup rows=0 ms=0'
    )
  })

  it('splits the read into the RPC round trip and the parsing after it', () => {
    expect(rankPublicationReadSplitLine('90D', { queryMs: 13044.4, parseMs: 912.6 })).toBe(
      '[90D] stage=read query_ms=13044 parse_ms=913'
    )
  })
})

describe('exclusionAlertDetails', () => {
  it('stays quiet under both thresholds', () => {
    expect(
      exclusionAlertDetails(
        { scored: 100, excluded: 10, byReason: {}, bySource: { a: { max_drawdown_missing: 10 } } },
        new Map([['a', 100]])
      )
    ).toBeNull()
  })

  it('alerts when the season-wide exclusion share is over 25%', () => {
    expect(
      exclusionAlertDetails({ scored: 100, excluded: 30, byReason: {}, bySource: {} }, new Map())
    ).toMatchObject({ seasonRatio: 0.3, sources: [] })
  })

  it('alerts on one source losing more than half of a meaningful cohort', () => {
    const details = exclusionAlertDetails(
      {
        scored: 1000,
        excluded: 30,
        byReason: {},
        bySource: { small: { max_drawdown_missing: 5 }, big: { max_drawdown_missing: 25 } },
      },
      new Map([
        ['small', 6],
        ['big', 40],
      ])
    )
    expect(details?.sources).toEqual([{ source: 'big', scored: 40, excluded: 25 }])
  })
})

describe('createPgRpcClient', () => {
  it('issues one named-argument call and encodes objects as jsonb text', async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = []
    const executor: RankPublicationSqlExecutor = {
      async query(text, values) {
        calls.push({ text, values })
        return { rows: [{ result: { ok: true } }] as never[], rowCount: 1 }
      },
    }
    const rpc = createPgRpcClient(executor)
    const envelope = await rpc.rpc('seal_leaderboard_rank_publication', {
      p_season_id: '90D',
      p_source_publications: [{ source: 'a' }],
    })
    expect(envelope).toEqual({ data: { ok: true }, error: null, status: 200 })
    expect(calls).toEqual([
      {
        text: 'SELECT public.seal_leaderboard_rank_publication(p_season_id => $1, p_source_publications => $2) AS result',
        values: ['90D', '[{"source":"a"}]'],
      },
    ])
  })

  it('turns a database error into a deterministic error envelope', async () => {
    const rpc = createPgRpcClient({
      async query() {
        throw Object.assign(new Error('rows were not fully written'), { code: '23514' })
      },
    })
    await expect(rpc.rpc('rerank_leaderboard_publication', {})).resolves.toEqual({
      data: null,
      error: { code: '23514', message: 'rows were not fully written' },
      status: 400,
    })
  })

  it('refuses identifiers that could inject SQL', async () => {
    const query = jest.fn()
    const rpc = createPgRpcClient({ query })
    const envelope = await rpc.rpc('x(); DROP TABLE y; --', {})
    expect(envelope.status).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('publishLeaderboardSeason gate', () => {
  const now = new Date()
  const iso = (date: Date) => date.toISOString().replace('Z', '000Z')
  // Most fixtures declare two or three sources; the expected-set floor has its
  // own tests below.
  const publish = (
    season: Parameters<typeof publishLeaderboardSeason>[0],
    deps: Parameters<typeof publishLeaderboardSeason>[1]
  ) => publishLeaderboardSeason(season, { minExpectedSources: 1, ...deps })

  function passedBoard(source: string, snapshotId: number) {
    return {
      registry_slug: source,
      filter_source: source,
      window: '90D',
      snapshot_id: snapshotId,
      scraped_at: iso(new Date(now.getTime() - 60 * 60 * 1000)),
      actual_count: 0,
      entry_count: 0,
      rank_limit: 1000,
      rank_limited_entry_count: 0,
      latest_passed_tie_count: 1,
      evidence_status: 'passed',
      latest_attempt_id: snapshotId,
      latest_attempt_scraped_at: iso(new Date(now.getTime() - 60 * 60 * 1000)),
      latest_attempt_passed: true,
    }
  }
  function missingBoard(source: string) {
    return {
      registry_slug: source,
      filter_source: source,
      window: '90D',
      snapshot_id: null,
      scraped_at: null,
      actual_count: null,
      entry_count: null,
      rank_limit: 1000,
      rank_limited_entry_count: null,
      latest_passed_tie_count: 0,
      evidence_status: 'missing',
      latest_attempt_id: null,
      latest_attempt_scraped_at: null,
      latest_attempt_passed: null,
    }
  }

  function harness(
    boards: unknown[],
    options: {
      sources?: string[]
      isolationSupported?: boolean
      trustEvidenceInstalled?: boolean
      untrustedSnapshotIds?: number[]
      /** 20261118113759 installed; `unsupported` is what its reader returns. */
      captureContractGate?: boolean
      unsupported?: string[]
    } = {}
  ) {
    const statements: string[] = []
    const parameters: unknown[][] = []
    const sources = options.sources ?? ['binance_futures', 'bybit']
    const unsupported = options.unsupported ?? []
    const untrusted = new Set(options.untrustedSnapshotIds ?? [])
    const executor: RankPublicationSqlExecutor = {
      async query(text, values) {
        statements.push(text)
        parameters.push([...(values ?? [])])
        if (text.includes("to_regclass('arena.leaderboard_publication_unsupported_sources')")) {
          return {
            rows: [{ supported: options.captureContractGate === true }] as never[],
            rowCount: 1,
          }
        }
        if (text.includes('FROM public.arena_publication_unsupported_sources()')) {
          return {
            rows: unsupported.map((source) => ({ source })) as never[],
            rowCount: unsupported.length,
          }
        }
        if (text.includes('leaderboard-rank-publication-evidence@2')) {
          return {
            rows: [{ supported: options.trustEvidenceInstalled !== false }] as never[],
            rowCount: 1,
          }
        }
        if (text.includes('FROM public.rank_publication_trust_evidence(')) {
          const ids = (values?.[0] ?? []) as number[]
          return {
            rows: ids.map((id) => ({ snapshot_id: String(id), trust_bound: !untrusted.has(id) })),
            rowCount: ids.length,
          } as never
        }
        if (text.includes('leaderboard-publication-source-isolation@1')) {
          return {
            rows: [{ supported: options.isolationSupported === true }] as never[],
            rowCount: 1,
          }
        }
        if (text.includes('DELETE FROM arena.leaderboard_publication_source_isolations')) {
          return { rows: [], rowCount: 0 }
        }
        if (text.includes('clock_timestamp()')) {
          return { rows: [{ now: iso(now) }] as never[], rowCount: 1 }
        }
        if (text.includes('arena_freshness_expected_sources')) {
          return {
            rows: sources.map((source) => ({ source })) as never[],
            rowCount: sources.length,
          }
        }
        if (text.includes(SOURCE_PUBLICATION_BUNDLE_RPC)) {
          return {
            rows: [
              { result: encodeColumnarScoreBundle({ scoreRows: [], physicalBoards: boards }) },
            ] as never[],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    let rolledBack = false
    const database: RankPublicationDatabase = {
      async transaction(work) {
        try {
          return await work(executor)
        } catch (error) {
          rolledBack = true
          throw error
        }
      },
    }
    return { statements, parameters, database, rolledBack: () => rolledBack }
  }

  it('refuses before any isolation, claim or write when the evidence chain is not installed', async () => {
    const { statements, database } = harness(
      [passedBoard('binance_futures', 1), passedBoard('bybit', 2)],
      { isolationSupported: true, trustEvidenceInstalled: false }
    )
    const scoreCohort = jest.fn()
    await expect(publish('90D', { database, scoreCohort })).rejects.toMatchObject({
      code: 'trust_evidence_not_installed',
    })
    expect(scoreCohort).not.toHaveBeenCalled()
    expect(statements.some((text) => /leaderboard_publication_source_isolations/.test(text))).toBe(
      false
    )
    expect(statements.some((text) => /claim_leaderboard_rank_generation/.test(text))).toBe(false)
  })

  it('isolates a fresh source whose PASSED board lacks attempt-bound evidence', async () => {
    const { statements, parameters, database } = harness(
      [passedBoard('binance_futures', 1), passedBoard('bybit', 2), passedBoard('hyperliquid', 3)],
      {
        sources: ['binance_futures', 'bybit', 'hyperliquid'],
        isolationSupported: true,
        untrustedSnapshotIds: [2],
      }
    )
    // The fixture authority does not shrink, so the cross-check refuses after
    // the isolation write; what matters is the isolation reason.
    await expect(
      publish('90D', { database, scoreCohort: jest.fn(), coreSources: [] })
    ).rejects.toMatchObject({ code: 'isolation_not_applied' })
    const isolationInsert = statements.findIndex((text) =>
      /INSERT INTO arena\.leaderboard_publication_source_isolations/.test(text)
    )
    expect(isolationInsert).toBeGreaterThan(-1)
    expect(JSON.parse(String(parameters[isolationInsert][1]))).toEqual([
      expect.objectContaining({ source: 'bybit', reasons: ['untrusted'] }),
    ])
  })

  it('refuses the season when most fresh sources are untrusted', async () => {
    const { statements, database } = harness(
      [passedBoard('binance_futures', 1), passedBoard('bybit', 2), passedBoard('hyperliquid', 3)],
      {
        sources: ['binance_futures', 'bybit', 'hyperliquid'],
        isolationSupported: true,
        untrustedSnapshotIds: [2, 3],
      }
    )
    await expect(
      publish('90D', { database, scoreCohort: jest.fn(), coreSources: [] })
    ).rejects.toMatchObject({
      code: 'expected_source_not_fresh',
      message: expect.stringContaining('bybit(untrusted), hyperliquid(untrusted)'),
    })
    expect(statements.some((text) => /INSERT INTO arena\.leaderboard_publication/.test(text))).toBe(
      false
    )
  })

  it('refuses before any claim or write when an expected source has no fresh board', async () => {
    const { statements, database, rolledBack } = harness([
      passedBoard('binance_futures', 1),
      missingBoard('bybit'),
    ])
    const scoreCohort = jest.fn()
    const error = await publish('90D', { database, scoreCohort }).catch(
      (failure: unknown) => failure
    )
    expect(error).toBeInstanceOf(RankPublicationError)
    expect((error as RankPublicationError).code).toBe('expected_source_not_fresh')
    expect((error as RankPublicationError).message).toContain('bybit(missing)')
    expect(rolledBack()).toBe(true)
    expect(scoreCohort).not.toHaveBeenCalled()
    expect(statements.some((text) => /claim_leaderboard_rank_generation/.test(text))).toBe(false)
    expect(statements.some((text) => /INSERT INTO public\.leaderboard_ranks/.test(text))).toBe(
      false
    )
  })

  it('refuses (and alerts) when more than half of the expected sources would be isolated', async () => {
    const { statements, database } = harness(
      [passedBoard('binance_futures', 1), missingBoard('bybit'), missingBoard('hyperliquid')],
      { sources: ['binance_futures', 'bybit', 'hyperliquid'], isolationSupported: true }
    )
    const alerts: unknown[] = []
    const error = await publish('90D', {
      database,
      scoreCohort: jest.fn(),
      alert: (alert) => void alerts.push(alert),
    }).catch((failure: unknown) => failure)
    expect((error as RankPublicationError).code).toBe('expected_source_not_fresh')
    expect((error as RankPublicationError).message).toContain('more than 50%')
    expect(alerts).toEqual([
      expect.objectContaining({ severity: 'critical', code: 'season_publication_refused' }),
    ])
    expect(statements.some((text) => /INSERT INTO arena\.leaderboard_publication/.test(text))).toBe(
      false
    )
  })

  it('refuses when every expected core source would be isolated', async () => {
    const { database } = harness(
      [passedBoard('binance_futures', 1), missingBoard('bybit'), passedBoard('hyperliquid', 3)],
      { sources: ['binance_futures', 'bybit', 'hyperliquid'], isolationSupported: true }
    )
    await expect(
      publish('90D', {
        database,
        scoreCohort: jest.fn(),
        coreSources: ['bybit'],
      })
    ).rejects.toMatchObject({
      code: 'expected_source_not_fresh',
      message: expect.stringContaining('every core source (bybit)'),
    })
  })

  it('isolates a minority stale source instead of refusing the season', async () => {
    const { statements, database } = harness(
      [passedBoard('binance_futures', 1), missingBoard('bybit'), passedBoard('hyperliquid', 3)],
      { sources: ['binance_futures', 'bybit', 'hyperliquid'], isolationSupported: true }
    )
    // The fixture's authority does not shrink after the isolation insert, so
    // the orchestrator's post-isolation cross-check must refuse.
    await expect(
      publish('90D', { database, scoreCohort: jest.fn(), coreSources: [] })
    ).rejects.toMatchObject({ code: 'isolation_not_applied' })
    const isolationInsert = statements.findIndex((text) =>
      /INSERT INTO arena\.leaderboard_publication_source_isolations/.test(text)
    )
    const eventInsert = statements.findIndex((text) =>
      /INSERT INTO arena\.leaderboard_publication_source_isolation_events/.test(text)
    )
    expect(isolationInsert).toBeGreaterThan(-1)
    expect(eventInsert).toBeGreaterThan(isolationInsert)
    expect(statements.some((text) => /claim_leaderboard_rank_generation/.test(text))).toBe(false)
  })

  it('counts rows whose required metric lacks board evidence instead of scoring them', async () => {
    const boardAsOf = iso(new Date(now.getTime() - 60 * 60 * 1000))
    const scoreRow = (traderKey: string, rank: number, overrides: Record<string, unknown>) => ({
      platform: 'binance_futures',
      market_type: 'futures',
      trader_key: traderKey,
      board_rank: rank,
      roi_pct: 40,
      pnl_usd: 900,
      win_rate: 55,
      max_drawdown: 12,
      copiers: null,
      trades_count: null,
      sharpe_ratio: null,
      sortino_ratio: null,
      calmar_ratio: null,
      volatility_pct: null,
      unevidenced_metrics: [],
      trader_kind: null,
      handle: null,
      avatar_url: null,
      currency: 'USDT',
      as_of: boardAsOf,
      board_as_of: boardAsOf,
      ...overrides,
    })
    const rows = [
      scoreRow('bound', 1, {}),
      // A win rate (or drawdown, or any optional metric) refused for evidence
      // does not exclude the row: it is scored with that metric empty.
      scoreRow('unbound-win-rate', 2, { win_rate: null, unevidenced_metrics: ['win_rate'] }),
      // ROI and PnL must be attested.
      scoreRow('unbound-roi', 3, { roi_pct: null, unevidenced_metrics: ['roi_pct'] }),
    ]
    const board = { ...passedBoard('binance_futures', 1), actual_count: 3, entry_count: 3 }
    const { database } = harness([board, passedBoard('bybit', 2)])
    const original = database.transaction
    database.transaction = (work) =>
      original(async (tx) =>
        work({
          async query(text, values) {
            if (text.includes(SOURCE_PUBLICATION_BUNDLE_RPC)) {
              return {
                rows: [
                  {
                    result: encodeColumnarScoreBundle({
                      scoreRows: rows,
                      physicalBoards: [
                        { ...board, rank_limited_entry_count: 3 },
                        passedBoard('bybit', 2),
                      ],
                    }),
                  },
                ] as never[],
                rowCount: 1,
              }
            }
            return tx.query(text, values)
          },
        })
      )
    const scoreCohort = jest.fn(async () => [])

    const error = await publish('90D', { database, scoreCohort }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RankPublicationError)
    expect((error as RankPublicationError).code).toBe('no_publishable_rows')
    const scorerInput = (scoreCohort.mock.calls[0] as unknown[])[0] as Array<{
      source_trader_id: string
    }>
    expect(scorerInput.map((row) => row.source_trader_id)).toEqual(['bound', 'unbound-win-rate'])
    expect(scorerInput[1]).toMatchObject({ win_rate: null, roi: 40, pnl: 900 })
    expect((error as RankPublicationError).details.exclusions).toEqual({
      scored: 3,
      excluded: 3,
      byReason: { score_input_evidence_missing: 1, filtered_by_scorer: 2 },
      bySource: {
        binance_futures: { score_input_evidence_missing: 1, filtered_by_scorer: 2 },
      },
    })
  })

  it('refuses a season whose sources are fresh but yield no publishable row', async () => {
    const { database } = harness([passedBoard('binance_futures', 1), passedBoard('bybit', 2)])
    await expect(publish('90D', { database, scoreCohort: async () => [] })).rejects.toMatchObject({
      code: 'no_publishable_rows',
    })
  })

  describe('capture-contract expected set (20261118113759)', () => {
    const registered = [
      'binance_futures',
      'bybit',
      'okx_futures',
      'gate_futures',
      'htx_futures',
      'blofin_futures',
      'coinex_futures',
      'lbank_futures',
    ]
    const uncontracted = [
      'bingx_futures',
      'bitfinex',
      'bitget_futures',
      'bitmart_futures',
      'gmx',
      'gtrade',
      'hyperliquid',
      'mexc_futures',
      'phemex_futures',
      'xt_spot',
    ]
    const boards = (fresh: readonly string[], missing: readonly string[] = []) => [
      ...fresh.map((source, index) => passedBoard(source, index + 1)),
      ...missing.map((source) => missingBoard(source)),
    ]
    const unsupportedInsert = (statements: string[]) =>
      statements.findIndex((text) =>
        /INSERT INTO arena\.leaderboard_publication_unsupported_sources/.test(text)
      )

    it('does not count unsupported sources against the fresh ratio and records them', async () => {
      const { statements, parameters, database } = harness(boards(registered), {
        sources: registered,
        unsupported: uncontracted,
        captureContractGate: true,
        isolationSupported: true,
      })
      const logs: string[] = []
      // Before the gate, 10 uncontracted of 18 expected (>50%) refused the
      // season; now the 8 registered sources are all fresh and it proceeds.
      await expect(
        publishLeaderboardSeason('90D', {
          database,
          scoreCohort: async () => [],
          log: (message) => void logs.push(message),
        })
      ).rejects.toMatchObject({ code: 'no_publishable_rows' })
      const insert = unsupportedInsert(statements)
      expect(insert).toBeGreaterThan(-1)
      expect(parameters[insert][0]).toBe('90D')
      expect(parameters[insert][2]).toEqual([...uncontracted].sort())
      expect(
        logs.some((line) => line.includes('unsupported') && line.includes('hyperliquid'))
      ).toBe(true)
      expect(
        statements.some((text) =>
          /INSERT INTO arena\.leaderboard_publication_source_isolations/.test(text)
        )
      ).toBe(false)
    })

    it('records an empty unsupported list too', async () => {
      const { statements, parameters, database } = harness(boards(registered), {
        sources: registered,
        captureContractGate: true,
        isolationSupported: true,
      })
      await expect(
        publishLeaderboardSeason('90D', { database, scoreCohort: async () => [] })
      ).rejects.toMatchObject({ code: 'no_publishable_rows' })
      expect(parameters[unsupportedInsert(statements)][2]).toEqual([])
    })

    it('still applies the >50% rule to the reduced expected set', async () => {
      const fresh = registered.slice(0, 3)
      const missing = registered.slice(3)
      const { statements, database } = harness(boards(fresh, missing), {
        sources: registered,
        unsupported: uncontracted,
        captureContractGate: true,
        isolationSupported: true,
      })
      const error = await publishLeaderboardSeason('90D', {
        database,
        scoreCohort: jest.fn(),
      }).catch((failure: unknown) => failure)
      expect(error).toMatchObject({
        code: 'expected_source_not_fresh',
        message: expect.stringContaining('5/8 expected source(s)'),
      })
      expect((error as RankPublicationError).message).toContain('more than 50%')
      expect((error as RankPublicationError).details.unsupportedSources).toEqual(
        [...uncontracted].sort()
      )
      expect(statements.some((text) => /claim_leaderboard_rank_generation/.test(text))).toBe(false)
    })

    it('treats an unsupported core source as down for the every-core-source rule', async () => {
      // binance_futures, bybit and okx_futures are stale; hyperliquid and
      // bitget_futures are unsupported. 3/8 stale stays under the ratio, but
      // every core source is down, so the season is refused.
      const stale = ['binance_futures', 'bybit', 'okx_futures']
      const { database } = harness(
        boards(
          registered.filter((source) => !stale.includes(source)),
          stale
        ),
        {
          sources: registered,
          unsupported: uncontracted,
          captureContractGate: true,
          isolationSupported: true,
        }
      )
      await expect(
        publishLeaderboardSeason('90D', { database, scoreCohort: jest.fn() })
      ).rejects.toMatchObject({
        code: 'expected_source_not_fresh',
        message: expect.stringContaining(
          'every core source (binance_futures, bitget_futures(unsupported), bybit, hyperliquid(unsupported), okx_futures)'
        ),
      })
    })

    it('refuses when every core source is unsupported even with no stale expected source', async () => {
      // A passed (e.g. legacy) board of an unsupported source is never core
      // evidence.
      const { database } = harness(boards([...registered, 'hyperliquid']), {
        sources: registered,
        unsupported: uncontracted,
        captureContractGate: true,
        isolationSupported: true,
      })
      await expect(
        publishLeaderboardSeason('90D', {
          database,
          scoreCohort: jest.fn(),
          coreSources: ['hyperliquid', 'bitget_futures'],
        })
      ).rejects.toMatchObject({
        code: 'expected_source_not_fresh',
        message: expect.stringContaining(
          'every core source (bitget_futures(unsupported), hyperliquid(unsupported))'
        ),
      })
    })

    it('keeps one fresh core source enough, as before', async () => {
      const stale = ['bybit', 'okx_futures']
      const { statements, database } = harness(
        boards(
          registered.filter((source) => !stale.includes(source)),
          stale
        ),
        {
          sources: registered,
          unsupported: uncontracted,
          captureContractGate: true,
          isolationSupported: true,
        }
      )
      // Isolation proceeds (the fixture authority does not shrink, so the
      // post-isolation cross-check is what refuses here).
      await expect(
        publishLeaderboardSeason('90D', { database, scoreCohort: jest.fn() })
      ).rejects.toMatchObject({ code: 'isolation_not_applied' })
      expect(
        statements.some((text) =>
          /INSERT INTO arena\.leaderboard_publication_source_isolations/.test(text)
        )
      ).toBe(true)
    })

    it('refuses below the expected-set floor with an explicit reason', async () => {
      const seven = registered.slice(0, 7)
      const { statements, database } = harness(boards(seven), {
        sources: seven,
        unsupported: uncontracted,
        captureContractGate: true,
        isolationSupported: true,
      })
      const alerts: unknown[] = []
      const error = await publishLeaderboardSeason('90D', {
        database,
        scoreCohort: jest.fn(),
        alert: (alert) => void alerts.push(alert),
      }).catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(RankPublicationError)
      expect((error as RankPublicationError).code).toBe('expected_set_below_floor')
      expect((error as RankPublicationError).message).toContain('below the floor of 8')
      expect((error as RankPublicationError).details).toMatchObject({
        expectedSources: [...seven].sort(),
        floor: 8,
      })
      expect(alerts).toEqual([
        expect.objectContaining({ severity: 'critical', code: 'season_publication_refused' }),
      ])
      expect(
        statements.some((text) => /INSERT INTO arena\.leaderboard_publication/.test(text))
      ).toBe(false)
    })

    it('never passes an emptied contract registry as 0/0', async () => {
      const { database } = harness([], {
        sources: [],
        unsupported: [...registered, ...uncontracted],
        captureContractGate: true,
        isolationSupported: true,
      })
      await expect(
        publishLeaderboardSeason('90D', { database, scoreCohort: jest.fn() })
      ).rejects.toMatchObject({
        code: 'expected_set_below_floor',
        message: expect.stringContaining('expected set has 0 source(s)'),
      })
    })

    it('reads and records nothing before the migration is installed', async () => {
      const { statements, database } = harness(boards(registered), {
        sources: registered,
        captureContractGate: false,
        isolationSupported: true,
      })
      await expect(
        publishLeaderboardSeason('90D', { database, scoreCohort: async () => [] })
      ).rejects.toMatchObject({ code: 'no_publishable_rows' })
      expect(
        statements.some((text) =>
          text.includes('FROM public.arena_publication_unsupported_sources()')
        )
      ).toBe(false)
      expect(unsupportedInsert(statements)).toBe(-1)
    })
  })
})
