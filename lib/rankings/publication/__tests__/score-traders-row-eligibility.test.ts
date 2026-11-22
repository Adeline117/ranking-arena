/**
 * @jest-environment node
 *
 * scoreTraders with the real Arena Score formula under both writer
 * eligibility policies (PUBLIC_RANKING_ROW_ELIGIBILITY).
 */

jest.mock('@/lib/rankings/publication/scoring-helpers', () => ({
  ...jest.requireActual('@/lib/rankings/publication/scoring-helpers'),
  applyArenaFollowers: async () => ({ applied: 0, uniqueAccounts: 0 }),
}))

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogger.info(...args),
    warn: (...args: unknown[]) => mockLogger.warn(...args),
    error: (...args: unknown[]) => mockLogger.error(...args),
  }),
}))

import { MIN_RANKED_ARENA_SCORE, scoreTraders, type ScoredTrader } from '../score-traders'
import type { TraderRow } from '../trader-row'
import type { PublicRankingRowEligibility } from '@/lib/rankings/publication-policy'

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

async function publishedCohort(
  rows: TraderRow[],
  rowEligibility: PublicRankingRowEligibility
): Promise<ScoredTrader[]> {
  const { scoredFiltered } = await scoreTraders(rows, new Map(), new Set(), '30D', {} as never, {
    rowEligibility,
  })
  return scoredFiltered
}

const byId = (cohort: ScoredTrader[]) => new Map(cohort.map((row) => [row.source_trader_id, row]))

beforeEach(() => {
  mockLogger.info.mockClear()
  mockLogger.warn.mockClear()
})

describe('display score floor', () => {
  // Four complete rows; "worst" has the lowest value on every dimension, so its
  // composite is the cohort minimum and its percentile display score is 0.00.
  const cohort = () => [
    traderRow('best', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('middle', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('loser', { roi: -5, pnl: -400, win_rate: 40, max_drawdown: 30 }),
    traderRow('worst', { roi: -40, pnl: -9_000, win_rate: 10, max_drawdown: 80 }),
  ]

  it("'roi_pnl' keeps the lowest-scoring trader at the 0.01 floor, ranked last", async () => {
    const scored = await publishedCohort(cohort(), 'roi_pnl')
    const rows = byId(scored)

    expect(scored).toHaveLength(4)
    expect(rows.get('worst')?.arena_score).toBe(MIN_RANKED_ARENA_SCORE)
    expect(rows.get('worst')?.arena_score_v4).toBe(MIN_RANKED_ARENA_SCORE)
    const order = [...scored]
      .sort((left, right) => right.arena_score! - left.arena_score!)
      .map((row) => row.source_trader_id)
    expect(order).toEqual(['best', 'middle', 'loser', 'worst'])
    for (const row of scored) {
      expect(row.arena_score).toBeGreaterThanOrEqual(MIN_RANKED_ARENA_SCORE)
      expect(row.arena_score).toBeLessThanOrEqual(100)
    }
  })

  it('gives losing traders a positive score below every profitable trader here', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    expect(rows.get('loser')!.arena_score!).toBeGreaterThan(MIN_RANKED_ARENA_SCORE)
    expect(rows.get('loser')!.arena_score!).toBeLessThan(rows.get('middle')!.arena_score!)
  })

  it("'four_metrics' keeps the previous behavior: the 0.00 row is not published", async () => {
    const scored = await publishedCohort(cohort(), 'four_metrics')
    expect(scored.map((row) => row.source_trader_id).sort()).toEqual(['best', 'loser', 'middle'])
  })
})
