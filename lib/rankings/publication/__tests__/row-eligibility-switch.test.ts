/**
 * @jest-environment node
 *
 * The writer switch. Merging the 'roi_pnl' rule must not change what a build
 * publishes: the default is 'four_metrics', the rule before the switch
 * existed, and only PUBLIC_RANKING_ROW_ELIGIBILITY=roi_pnl turns the new rule on.
 */

jest.mock('@/lib/rankings/publication/scoring-helpers', () => ({
  ...jest.requireActual('@/lib/rankings/publication/scoring-helpers'),
  applyArenaFollowers: async () => ({ applied: 0, uniqueAccounts: 0 }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import {
  DEFAULT_PUBLIC_RANKING_ROW_ELIGIBILITY,
  PUBLIC_RANKING_ROW_ELIGIBILITY_ENV,
  publicRankingRowEligibility,
  resolvePublicRankingRowEligibility,
} from '@/lib/rankings/publication-policy'
import { computeArenaScoresV4 } from '@/lib/utils/arena-score'
import {
  classifyPublishableRow,
  publishLeaderboardSeason,
  type RankPublicationDatabase,
} from '../publish-season'
import { scoreTraders, type ScoredTrader } from '../score-traders'
import {
  lacksRequiredMetricEvidence,
  RANK_REQUIRED_SCORE_INPUT_METRICS,
  type SourcePublicationScoreRow,
} from '../source-publication-evidence'
import type { TraderRow } from '../trader-row'

const ENV = PUBLIC_RANKING_ROW_ELIGIBILITY_ENV

function traderRow(id: string, overrides: Partial<TraderRow> = {}): TraderRow {
  return {
    source: 'bybit',
    source_trader_id: id,
    roi: 10,
    pnl: 1_000,
    win_rate: 55,
    max_drawdown: 12,
    trades_count: null,
    followers: null,
    copiers: null,
    arena_score: null,
    captured_at: '2026-11-22T10:00:00.000Z',
    source_board_as_of: '2026-11-22T10:00:00.000Z',
    full_confidence_at: null,
    profitability_score: null,
    risk_control_score: null,
    execution_score: null,
    score_completeness: null,
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    metrics_estimated: false,
    ...overrides,
  }
}

/** Every case the new rule treats differently, plus ordinary complete rows. */
const cohort = (): TraderRow[] => [
  traderRow('full-1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5, trades_count: 140 }),
  traderRow('full-2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15, sharpe_ratio: 1.2 }),
  traderRow('full-3', { roi: 6, pnl: 900, win_rate: 48, max_drawdown: 35, trades_count: 30 }),
  traderRow('full-loss', { roi: -9, pnl: -300, win_rate: 41, max_drawdown: 44 }),
  traderRow('full-worst', { roi: -60, pnl: -9_000, win_rate: 10, max_drawdown: 80 }),
  traderRow('zero-drawdown', { roi: 12, pnl: 1_500, win_rate: 60, max_drawdown: 0 }),
  traderRow('zero-win-rate', { roi: 3, pnl: 200, win_rate: 0, max_drawdown: 22 }),
  traderRow('loss-zero-drawdown', { roi: -12, pnl: -1_500, win_rate: 60, max_drawdown: 0 }),
  traderRow('idle-complete', { roi: 0, pnl: 0, win_rate: 0, max_drawdown: 0 }),
  traderRow('idle-bare', { roi: 0, pnl: 0, win_rate: null, max_drawdown: null }),
  traderRow('no-win-rate', { roi: 40, pnl: 30_000, win_rate: null }),
  traderRow('no-drawdown', { roi: 25, pnl: 8_000, max_drawdown: null }),
  traderRow('roi-pnl-only', { roi: 300, pnl: 900_000, win_rate: null, max_drawdown: null }),
  traderRow('liquidated', { roi: 15, pnl: 4_000, max_drawdown: 100 }),
]

async function score(rowEligibility?: 'roi_pnl' | 'four_metrics'): Promise<ScoredTrader[]> {
  const { scoredFiltered } = await scoreTraders(
    cohort(),
    new Map(),
    new Set(),
    '30D',
    {} as never,
    rowEligibility === undefined ? undefined : { rowEligibility }
  )
  return scoredFiltered
}

const original = process.env[ENV]
afterEach(() => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
})

describe('resolvePublicRankingRowEligibility', () => {
  it('defaults to the old rule', () => {
    expect(DEFAULT_PUBLIC_RANKING_ROW_ELIGIBILITY).toBe('four_metrics')
    expect(resolvePublicRankingRowEligibility(undefined)).toEqual({
      value: 'four_metrics',
      source: 'unset',
      description:
        'row eligibility: four_metrics (PUBLIC_RANKING_ROW_ELIGIBILITY is not set; default)',
    })
    expect(resolvePublicRankingRowEligibility('')).toMatchObject({
      value: 'four_metrics',
      source: 'unset',
    })
    expect(resolvePublicRankingRowEligibility('   ')).toMatchObject({
      value: 'four_metrics',
      source: 'unset',
    })
  })

  it('turns the new rule on only for the exact value', () => {
    expect(resolvePublicRankingRowEligibility('roi_pnl')).toEqual({
      value: 'roi_pnl',
      source: 'set',
      description: 'row eligibility: roi_pnl (PUBLIC_RANKING_ROW_ELIGIBILITY)',
    })
    expect(resolvePublicRankingRowEligibility('four_metrics')).toMatchObject({
      value: 'four_metrics',
      source: 'set',
    })
  })

  it.each(['ROI_PNL', ' roi_pnl', 'roi_pnl ', 'roi-pnl', 'true', '1', 'on', 'new', 'roi_pnl,x'])(
    'falls back to the old rule for the unrecognized value %p, and says so',
    (raw) => {
      const resolved = resolvePublicRankingRowEligibility(raw)
      expect(resolved.value).toBe('four_metrics')
      expect(resolved.source).toBe('unrecognized')
      expect(resolved.description).toContain('is not recognized; expected roi_pnl or four_metrics')
      expect(resolved.description).toContain('row eligibility: four_metrics')
    }
  )

  it('reads the process environment on every call', () => {
    delete process.env[ENV]
    expect(publicRankingRowEligibility()).toBe('four_metrics')
    process.env[ENV] = 'roi_pnl'
    expect(publicRankingRowEligibility()).toBe('roi_pnl')
    process.env[ENV] = 'yes'
    expect(publicRankingRowEligibility()).toBe('four_metrics')
  })
})

describe('with the variable unset the writer behaves exactly as before the switch', () => {
  beforeEach(() => {
    delete process.env[ENV]
  })

  it('scores with the signed computeArenaScoresV4 contract over complete rows only', async () => {
    const published = await score()

    // What the scorer did before this change, written out independently:
    // complete rows only (both metrics present and in range), the historical
    // v4 batch formula, the 0.00 row dropped, no floor, no marker.
    const complete = cohort().filter(
      (row) =>
        row.win_rate !== null &&
        row.max_drawdown !== null &&
        row.max_drawdown >= 0 &&
        row.max_drawdown < 100
    )
    const expected = computeArenaScoresV4(
      complete.map((row) => ({
        roi: row.roi as number,
        pnl: row.pnl,
        maxDrawdown: row.max_drawdown,
        winRate: row.win_rate,
        sharpeRatio: row.sharpe_ratio,
        profitFactor: null,
        tradesCount: row.trades_count,
        source: row.source,
      })),
      '30D'
    )
      .map((result, index) => ({ id: complete[index].source_trader_id, result }))
      .filter(({ result }) => result.totalScore > 0)

    expect(published.map((row) => row.source_trader_id)).toEqual(expected.map(({ id }) => id))
    for (const [index, row] of published.entries()) {
      expect(row.arena_score).toBe(expected[index].result.totalScore)
      expect(row.arena_score_v4).toBe(expected[index].result.totalScore)
      expect(row.score_factors).toEqual(expected[index].result.factors)
      expect(row.score_completeness).toBe('full')
    }
    // The rows the new rule adds or treats specially are simply not there, or
    // are scored like any other row.
    const ids = published.map((row) => row.source_trader_id)
    for (const absent of [
      'idle-bare',
      'no-win-rate',
      'no-drawdown',
      'roi-pnl-only',
      'liquidated',
    ]) {
      expect(ids).not.toContain(absent)
    }
    const byId = new Map(published.map((row) => [row.source_trader_id, row]))
    expect(byId.get('idle-complete')?.score_factors).not.toHaveProperty('idle_window')
    expect(byId.get('loss-zero-drawdown')?.max_drawdown).toBe(0)
    expect(byId.get('loss-zero-drawdown')?.score_factors).not.toHaveProperty('mdd_contradiction')
    // 0 read as missing, as before.
    expect(byId.get('zero-drawdown')?.score_factors?.drawdown).toBeNull()
  })

  it('writes neither mark, so the public view flags are false on every row', async () => {
    // public.public_ranked_leaderboard.idle_window / .mdd_contradiction read
    // these two keys of score_factors (20261123021904).
    for (const row of await score()) {
      expect(row.score_factors).not.toHaveProperty('idle_window')
      expect(row.score_factors).not.toHaveProperty('mdd_contradiction')
    }
  })

  it('is the explicit four_metrics rule, value for value', async () => {
    expect(await score()).toEqual(await score('four_metrics'))
  })

  it('differs from the new rule, which only the variable turns on', async () => {
    const before = await score()
    const after = await score('roi_pnl')
    expect(after.length).toBeGreaterThan(before.length)

    process.env[ENV] = 'roi_pnl'
    expect(await score()).toEqual(after)
    process.env[ENV] = 'ROI_PNL'
    expect(await score()).toEqual(before)
  })

  it('requires evidence for all four metrics and classifies rows by the old rule', async () => {
    expect(RANK_REQUIRED_SCORE_INPUT_METRICS).toEqual([
      'roi_pct',
      'pnl_usd',
      'win_rate',
      'max_drawdown',
    ])
    const unboundWinRate = {
      win_rate: null,
      unevidenced_metrics: ['win_rate'],
    } as unknown as SourcePublicationScoreRow
    expect(lacksRequiredMetricEvidence(unboundWinRate)).toBe(true)

    const [row] = await score('roi_pnl')
    const partial = { ...row, win_rate: null, score_completeness: 'partial' as const }
    expect(classifyPublishableRow(partial)).toEqual({ reason: 'incomplete_or_estimated' })

    process.env[ENV] = 'roi_pnl'
    expect(lacksRequiredMetricEvidence(unboundWinRate)).toBe(false)
    expect(classifyPublishableRow(partial)).toHaveProperty('row')
  })
})

describe('the orchestrator logs the rule it resolved, once per publication', () => {
  const refusing: RankPublicationDatabase = {
    async transaction() {
      throw new Error('stop before any statement')
    },
  }

  async function firstLogLine(rowEligibility?: 'roi_pnl' | 'four_metrics'): Promise<string> {
    const logs: string[] = []
    await publishLeaderboardSeason('90D', {
      database: refusing,
      scoreCohort: async () => [],
      log: (message) => void logs.push(message),
      rowEligibility,
    }).catch(() => undefined)
    return logs[0]
  }

  it('unset: the old rule, named as the default', async () => {
    delete process.env[ENV]
    expect(await firstLogLine()).toBe(
      '[90D] row eligibility: four_metrics (PUBLIC_RANKING_ROW_ELIGIBILITY is not set; default)'
    )
  })

  it('set to roi_pnl: the new rule', async () => {
    process.env[ENV] = 'roi_pnl'
    expect(await firstLogLine()).toBe(
      '[90D] row eligibility: roi_pnl (PUBLIC_RANKING_ROW_ELIGIBILITY)'
    )
  })

  it('unrecognized: the old rule, with the offending value', async () => {
    process.env[ENV] = 'enabled'
    expect(await firstLogLine()).toBe(
      '[90D] row eligibility: four_metrics (PUBLIC_RANKING_ROW_ELIGIBILITY="enabled" is not recognized; expected roi_pnl or four_metrics; default)'
    )
  })

  it('an explicit dependency wins over the environment (tests, fixtures)', async () => {
    delete process.env[ENV]
    expect(await firstLogLine('roi_pnl')).toBe('[90D] row eligibility: roi_pnl (explicit)')
  })
})
