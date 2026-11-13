import { createPgRpcClient } from '../pg-rpc-client'
import {
  classifyPublishableRow,
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
    ['partial completeness', { score_completeness: 'partial' as const }],
    ['estimated metrics', { metrics_estimated: true }],
    ['outlier', { is_outlier: true }],
    ['zero score', { arena_score: 0 }],
    ['score above 100', { arena_score: 100.01 }],
    ['ROI beyond the clamp', { roi: 10000.5 }],
    ['drawdown of 100%', { max_drawdown: 99.996 }],
    ['missing win rate', { win_rate: null }],
    ['untrimmed identity', { source_trader_id: ' x' }],
    ['non-canonical source', { source: 'Binance' }],
  ])('rejects rows the database seal would refuse: %s', (_label, overrides) => {
    expect(toPublishableRow(scored(overrides))).toBeNull()
  })
})

describe('classifyPublishableRow', () => {
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
    expect(classifyPublishableRow(scored(overrides))).toEqual({ reason })
  })

  it('returns the row when every rule passes', () => {
    expect(classifyPublishableRow(scored())).toHaveProperty('row.source', 'binance_futures')
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

  function harness(boards: unknown[]) {
    const statements: string[] = []
    const executor: RankPublicationSqlExecutor = {
      async query(text) {
        statements.push(text)
        if (text.includes('clock_timestamp()')) {
          return { rows: [{ now: iso(now) }] as never[], rowCount: 1 }
        }
        if (text.includes('arena_freshness_expected_sources')) {
          return {
            rows: [{ source: 'binance_futures' }, { source: 'bybit' }] as never[],
            rowCount: 2,
          }
        }
        if (text.includes('arena_score_inputs_publish_bundle_json')) {
          return {
            rows: [{ result: { scoreRows: [], physicalBoards: boards } }] as never[],
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
    return { statements, database, rolledBack: () => rolledBack }
  }

  it('refuses before any claim or write when an expected source has no fresh board', async () => {
    const { statements, database, rolledBack } = harness([
      passedBoard('binance_futures', 1),
      missingBoard('bybit'),
    ])
    const scoreCohort = jest.fn()
    const error = await publishLeaderboardSeason('90D', { database, scoreCohort }).catch(
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

  it('refuses a season whose sources are fresh but yield no publishable row', async () => {
    const { database } = harness([passedBoard('binance_futures', 1), passedBoard('bybit', 2)])
    await expect(
      publishLeaderboardSeason('90D', { database, scoreCohort: async () => [] })
    ).rejects.toMatchObject({ code: 'no_publishable_rows' })
  })
})
