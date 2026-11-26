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

import {
  MIN_ACTIVE_ARENA_SCORE,
  MIN_RANKED_ARENA_SCORE,
  hasContradictoryDrawdown,
  hasSignMismatch,
  hasUnverifiedZeroDrawdown,
  isIdleWindowRow,
  scoreTraders,
  type ScoredTrader,
} from '../score-traders'
import { classifyPublishableRow, orderRowsForWrite } from '../publish-season'
import type { TraderRow } from '../trader-row'
import { computeArenaScoresV4 } from '@/lib/utils/arena-score'
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

  it("'roi_pnl' keeps the lowest-scoring trader at the active floor, ranked last", async () => {
    const scored = await publishedCohort(cohort(), 'roi_pnl')
    const rows = byId(scored)

    expect(scored).toHaveLength(4)
    // One step above the idle-window score, so a trader with a result never
    // shares a score with the idle rows.
    expect(MIN_ACTIVE_ARENA_SCORE).toBe(0.02)
    expect(rows.get('worst')?.arena_score).toBe(MIN_ACTIVE_ARENA_SCORE)
    expect(rows.get('worst')?.arena_score_v4).toBe(MIN_ACTIVE_ARENA_SCORE)
    const order = [...scored]
      .sort((left, right) => right.arena_score! - left.arena_score!)
      .map((row) => row.source_trader_id)
    expect(order).toEqual(['best', 'middle', 'loser', 'worst'])
    for (const row of scored) {
      expect(row.arena_score).toBeGreaterThanOrEqual(MIN_ACTIVE_ARENA_SCORE)
      expect(row.arena_score).toBeLessThanOrEqual(100)
    }
  })

  it('gives losing traders a positive score below every profitable trader here', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    expect(rows.get('loser')!.arena_score!).toBeGreaterThan(MIN_ACTIVE_ARENA_SCORE)
    expect(rows.get('loser')!.arena_score!).toBeLessThan(rows.get('middle')!.arena_score!)
  })

  it("'four_metrics' keeps the previous behavior: the 0.00 row is not published", async () => {
    const scored = await publishedCohort(cohort(), 'four_metrics')
    expect(scored.map((row) => row.source_trader_id).sort()).toEqual(['best', 'loser', 'middle'])
  })
})

describe("cohort admission under 'roi_pnl'", () => {
  const filler = () => [
    traderRow('f1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('f2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('f3', { roi: -5, pnl: -400, win_rate: 40, max_drawdown: 30 }),
    traderRow('f4', { roi: -60, pnl: -9_000, win_rate: 10, max_drawdown: 80 }),
  ]

  it('ranks rows that only have ROI and PnL, and labels what they carry', async () => {
    const rows = byId(
      await publishedCohort(
        [
          ...filler(),
          traderRow('only-roi-pnl', { win_rate: null, max_drawdown: null }),
          traderRow('no-win-rate', { win_rate: null }),
          traderRow('no-drawdown', { max_drawdown: null }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.get('only-roi-pnl')).toMatchObject({
      score_completeness: 'minimal',
      win_rate: null,
      max_drawdown: null,
    })
    expect(rows.get('no-win-rate')).toMatchObject({ score_completeness: 'partial', win_rate: null })
    expect(rows.get('no-drawdown')).toMatchObject({
      score_completeness: 'partial',
      max_drawdown: null,
    })
    for (const id of ['only-roi-pnl', 'no-win-rate', 'no-drawdown']) {
      expect(rows.get(id)!.arena_score!).toBeGreaterThanOrEqual(MIN_RANKED_ARENA_SCORE)
    }
  })

  it.each([
    ['missing ROI', { roi: null }],
    ['missing PnL', { pnl: null }],
    ['ROI beyond the 30D bound', { roi: 5_001 }],
    ['estimated metrics', { metrics_estimated: true }],
    // markOutliers: |ROI| > 500% with no PnL behind it.
    ['outlier', { roi: 900, pnl: 0 }],
  ] as const)('does not rank a row with %s', async (_label, overrides) => {
    const rows = byId(
      await publishedCohort([...filler(), traderRow('subject', overrides)], 'roi_pnl')
    )
    expect(rows.has('subject')).toBe(false)
    expect(rows.size).toBe(4)
  })

  it('empties a drawdown >= 100 and an out-of-range win rate, keeps the row, and logs the count', async () => {
    const rows = byId(
      await publishedCohort(
        [
          ...filler(),
          traderRow('liquidated', { max_drawdown: 100 }),
          traderRow('win-rate-150', { win_rate: 150 }),
          traderRow('win-rate-negative', { win_rate: -1 }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.get('liquidated')).toMatchObject({
      max_drawdown: null,
      win_rate: 55,
      score_completeness: 'partial',
    })
    expect(rows.get('win-rate-150')).toMatchObject({
      win_rate: null,
      score_completeness: 'partial',
    })
    expect(rows.get('win-rate-negative')).toMatchObject({ win_rate: null })
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[30D] Emptied out-of-range risk metrics (row kept): win_rate=2, max_drawdown=1'
    )
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[30D] Ranking cohort completeness (roi_pnl): full=4, partial=3, minimal=0'
    )
  })

  it('ranks the two blofin row shapes with the metric empty and never reads a carried value', async () => {
    // #534: a blofin idle-window account has board max_drawdown NULL (the
    // carried value lives in extras.carried_mdd, which the scorer never sees).
    // #535: a blofin futures board row whose win rate was 0 is NULL.
    const idleWindow = {
      ...traderRow('blofin-idle-window', {
        source: 'blofin',
        roi: 0,
        pnl: 0,
        win_rate: 48,
        max_drawdown: null,
      }),
      extras: { carried_mdd: 37.5 },
    } as TraderRow
    const noWinRate = traderRow('blofin-zero-win-rate', {
      source: 'blofin',
      roi: 14,
      pnl: 2_300,
      win_rate: null,
      max_drawdown: 9,
    })
    const rows = byId(await publishedCohort([...filler(), idleWindow, noWinRate], 'roi_pnl'))

    expect(rows.get('blofin-idle-window')).toMatchObject({
      max_drawdown: null,
      win_rate: 48,
      score_completeness: 'partial',
    })
    expect(rows.get('blofin-idle-window')!.score_factors).toMatchObject({ drawdown: null })
    expect(rows.get('blofin-zero-win-rate')).toMatchObject({
      win_rate: null,
      max_drawdown: 9,
      score_completeness: 'partial',
    })
    expect(rows.get('blofin-zero-win-rate')!.score_factors).toMatchObject({ consistency: null })

    // Under the previous rule neither is ranked.
    const rollback = byId(
      await publishedCohort([...filler(), idleWindow, noWinRate], 'four_metrics')
    )
    expect(rollback.has('blofin-idle-window')).toBe(false)
    expect(rollback.has('blofin-zero-win-rate')).toBe(false)
  })
})

describe('null and 0 are different through the publication scorer', () => {
  const others = () => [
    traderRow('o1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('o2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('o3', { roi: -5, pnl: -400, win_rate: 40, max_drawdown: 30 }),
    traderRow('o4', { roi: -60, pnl: -9_000, win_rate: 10, max_drawdown: 80 }),
  ]

  // A 100% win rate corroborates the 0% drawdown (see the mdd_zero_unverified
  // block for a 0 with a lower win rate).
  it('a 0% drawdown is the best drawdown; a missing one scores nothing', async () => {
    const rows = byId(
      await publishedCohort(
        [
          ...others(),
          traderRow('dd-zero', { max_drawdown: 0, win_rate: 100 }),
          traderRow('dd-missing', { max_drawdown: null }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.get('dd-zero')).toMatchObject({ max_drawdown: 0, score_completeness: 'full' })
    expect(rows.get('dd-zero')!.score_factors!.drawdown).toBe(1)
    expect(rows.get('dd-missing')!.score_factors!.drawdown).toBeNull()
    expect(rows.get('dd-zero')!.arena_score!).toBeGreaterThan(rows.get('dd-missing')!.arena_score!)
  })

  it('a 0% win rate is the worst win rate, and is still present data', async () => {
    const rows = byId(
      await publishedCohort(
        [
          ...others(),
          traderRow('wr-zero', { win_rate: 0 }),
          traderRow('wr-missing', { win_rate: null }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.get('wr-zero')).toMatchObject({ win_rate: 0, score_completeness: 'full' })
    expect(rows.get('wr-zero')!.score_factors!.consistency).toBe(0)
    expect(rows.get('wr-missing')!.score_factors!.consistency).toBeNull()
    // Both contribute 0 to quality; the observation counts toward confidence,
    // so the missing twin is never above it.
    expect(rows.get('wr-missing')!.arena_score!).toBeLessThanOrEqual(
      rows.get('wr-zero')!.arena_score!
    )
  })

  it("'four_metrics' restores the legacy reading of 0 as missing", async () => {
    const rows = byId(
      await publishedCohort(
        [...others(), traderRow('dd-zero', { max_drawdown: 0 })],
        'four_metrics'
      )
    )
    expect(rows.get('dd-zero')!.score_factors!.drawdown).toBeNull()
  })
})

describe('a missing risk metric never lifts a trader through the publication scorer', () => {
  it.each([
    ['trade count unknown', null],
    ['trade count known', 120],
  ] as const)('%s', async (_label, tradesCount) => {
    const cohort = Array.from({ length: 30 }, (_, i) =>
      traderRow(`c${i}`, {
        roi: i * 3 - 20,
        pnl: i * 2_000 - 9_000,
        win_rate: 30 + i,
        max_drawdown: 60 - i,
        trades_count: tradesCount,
      })
    )
    const twin = {
      roi: 400,
      pnl: 900_000,
      win_rate: 33,
      max_drawdown: 55,
      trades_count: tradesCount,
    }
    const rows = byId(
      await publishedCohort(
        [
          ...cohort,
          traderRow('complete', twin),
          traderRow('no-drawdown', { ...twin, max_drawdown: null }),
          traderRow('no-win-rate', { ...twin, win_rate: null }),
          traderRow('neither', { ...twin, win_rate: null, max_drawdown: null }),
        ],
        'roi_pnl'
      )
    )
    const complete = rows.get('complete')!.arena_score!
    expect(rows.get('no-drawdown')!.arena_score!).toBeLessThanOrEqual(complete)
    expect(rows.get('no-win-rate')!.arena_score!).toBeLessThanOrEqual(complete)
    expect(rows.get('neither')!.arena_score!).toBeLessThan(complete)
    expect(rows.get('neither')!.arena_score!).toBeLessThanOrEqual(
      rows.get('no-drawdown')!.arena_score!
    )
    expect(rows.get('neither')!.arena_score!).toBeLessThanOrEqual(
      rows.get('no-win-rate')!.arena_score!
    )
  })
})

describe('idle-window rows (ROI 0 and PnL 0) are ranked last and not scored', () => {
  // The shape production has after the relaxation: about half of the rows are
  // idle accounts. Some carry no risk metrics, some report a 0% drawdown and a
  // 0% win rate, some carry ordinary values.
  const idleRows = () => [
    ...Array.from({ length: 20 }, (_, i) =>
      traderRow(`idle-none-${String(i).padStart(2, '0')}`, {
        source: 'xt',
        roi: 0,
        pnl: 0,
        win_rate: null,
        max_drawdown: null,
      })
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      traderRow(`idle-zero-dd-${String(i).padStart(2, '0')}`, {
        source: 'bybit',
        roi: 0,
        pnl: 0,
        win_rate: 0,
        max_drawdown: 0,
      })
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      traderRow(`idle-with-risk-${String(i).padStart(2, '0')}`, {
        source: 'bitunix',
        roi: 0,
        pnl: 0,
        win_rate: 62,
        max_drawdown: 4,
        trades_count: 300,
      })
    ),
  ]
  const profitable = () => [
    traderRow('profit-full-1', { roi: 85, pnl: 240_000, win_rate: 66, max_drawdown: 9 }),
    traderRow('profit-full-2', { roi: 31, pnl: 18_000, win_rate: 58, max_drawdown: 14 }),
    traderRow('profit-full-3', { roi: 4, pnl: 600, win_rate: 51, max_drawdown: 22 }),
    traderRow('profit-partial', { roi: 12, pnl: 2_500, win_rate: null, max_drawdown: 18 }),
    // The weakest profitable rows: tiny gains and no risk metrics at all.
    traderRow('profit-minimal-1', { roi: 0.4, pnl: 3, win_rate: null, max_drawdown: null }),
    traderRow('profit-minimal-2', { roi: 0.01, pnl: 0.5, win_rate: null, max_drawdown: null }),
  ]
  const losing = () => [
    traderRow('loss-full-1', { roi: -8, pnl: -900, win_rate: 45, max_drawdown: 28 }),
    traderRow('loss-full-2', { roi: -55, pnl: -40_000, win_rate: 22, max_drawdown: 71 }),
    traderRow('loss-minimal-1', { roi: -3, pnl: -20, win_rate: null, max_drawdown: null }),
    // The single worst row of the cohort: percentile 0 on everything.
    traderRow('loss-minimal-2', { roi: -70, pnl: -5_000, win_rate: null, max_drawdown: null }),
  ]
  // Rows with a result in only one of the two: they have performance.
  const oneSided = () => [
    traderRow('roi-zero-pnl-positive', { roi: 0, pnl: 12, win_rate: null, max_drawdown: null }),
    traderRow('roi-positive-pnl-zero', { roi: 1.5, pnl: 0, win_rate: null, max_drawdown: null }),
  ]
  const everyone = () => [...idleRows(), ...losing(), ...profitable(), ...oneSided()]
  const isIdleId = (id: string) => id.startsWith('idle-')

  /**
   * What the database does with the written rows: a first-time row takes the
   * next id in arrival order; rank = ROW_NUMBER() OVER (ORDER BY arena_score
   * DESC NULLS LAST, id) (rerank_leaderboard_publication).
   */
  function rerank(
    written: Array<{ source_trader_id: string; arena_score: number }>,
    existingIds: Map<string, number> = new Map()
  ): { order: string[]; ids: Map<string, number> } {
    const ids = new Map(existingIds)
    let nextId = Math.max(0, ...ids.values()) + 1
    for (const row of written) {
      if (!ids.has(row.source_trader_id)) ids.set(row.source_trader_id, nextId++)
    }
    const order = [...written]
      .sort(
        (left, right) =>
          right.arena_score - left.arena_score ||
          ids.get(left.source_trader_id)! - ids.get(right.source_trader_id)!
      )
      .map((row) => row.source_trader_id)
    return { order, ids }
  }

  async function publish(input: TraderRow[]) {
    const scored = await publishedCohort(input, 'roi_pnl')
    const rows = scored.map((trader) => {
      const verdict = classifyPublishableRow(trader, 'roi_pnl')
      if (!('row' in verdict)) throw new Error(`unexpected exclusion of ${trader.source_trader_id}`)
      return verdict.row
    })
    return orderRowsForWrite(rows)
  }

  it('gives every idle row the floor score, marks it, and keeps its own metrics', async () => {
    const rows = byId(await publishedCohort(everyone(), 'roi_pnl'))

    for (const trader of idleRows()) {
      const row = rows.get(trader.source_trader_id)!
      expect(row.arena_score).toBe(MIN_RANKED_ARENA_SCORE)
      expect(row.arena_score_v4).toBe(MIN_RANKED_ARENA_SCORE)
      expect(row.score_factors).toEqual({
        roi: 0,
        pnl: 0,
        drawdown: null,
        sharpe: null,
        consistency: null,
        idle_window: true,
      })
      // Not "0 read as missing": the metrics stay exactly as reported.
      expect(row.win_rate).toBe(trader.win_rate)
      expect(row.max_drawdown).toBe(trader.max_drawdown)
      expect(row.profitability_score).toBe(0)
      expect(row.risk_control_score).toBe(0)
      expect(row.execution_score).toBeNull()
    }
    expect(rows.get('idle-zero-dd-00')).toMatchObject({
      win_rate: 0,
      max_drawdown: 0,
      score_completeness: 'full',
    })
    expect(rows.get('idle-none-00')).toMatchObject({ score_completeness: 'minimal' })

    // Every row with performance is scored, has no marker, and is above the floor.
    for (const trader of [...profitable(), ...losing(), ...oneSided()]) {
      const row = rows.get(trader.source_trader_id)!
      expect(row.score_factors).not.toHaveProperty('idle_window')
      expect(row.arena_score!).toBeGreaterThanOrEqual(MIN_ACTIVE_ARENA_SCORE)
    }
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[30D] Idle-window rows (ROI 0 and PnL 0, not scored, score 0.01): 60 of 72'
    )
  })

  it('ranks every idle row after every row with a profit or a loss, whatever its drawdown', async () => {
    const written = await publish(everyone())
    const { order } = rerank(written)

    expect(order).toHaveLength(72)
    const firstIdle = order.findIndex(isIdleId)
    expect(firstIdle).toBe(12)
    // Nothing with performance below the first idle row, and nothing idle above it.
    expect(order.slice(0, firstIdle).some(isIdleId)).toBe(false)
    expect(order.slice(firstIdle).every(isIdleId)).toBe(true)
    // The idle rows that report a 0% drawdown are in the block like the others.
    expect(order.slice(firstIdle).filter((id) => id.startsWith('idle-zero-dd-'))).toHaveLength(20)
  })

  it('ranks losing traders above the idle rows: a loss is performance', async () => {
    const written = await publish(everyone())
    const { order } = rerank(written)
    const position = new Map(order.map((id, index) => [id, index]))
    const firstIdle = order.findIndex(isIdleId)

    for (const trader of losing()) {
      expect(position.get(trader.source_trader_id)!).toBeLessThan(firstIdle)
    }
    // The worst scored row sits on the active floor, one step above the idle score.
    expect(order[firstIdle - 1]).toBe('loss-minimal-2')
    expect(written.find((row) => row.source_trader_id === 'loss-minimal-2')!.arena_score).toBe(
      MIN_ACTIVE_ARENA_SCORE
    )
  })

  it('orders the idle rows among themselves by source, then trader id', async () => {
    const written = await publish(everyone())
    const { order } = rerank(written)
    const idleBlock = order.filter(isIdleId)
    const expected = idleRows()
      .map((row) => [row.source, row.source_trader_id] as const)
      .sort(
        (left, right) =>
          (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0) ||
          (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
      )
      .map(([, id]) => id)
    expect(idleBlock).toEqual(expected)
    // They are written last, so their ids are one run after every other row's.
    expect(written.slice(-60).map((row) => row.source_trader_id)).toEqual(expected)
    expect(written.slice(0, 12).some((row) => isIdleId(row.source_trader_id))).toBe(false)
  })

  it('gives the same ranks whatever order the rows arrive in, and on republication', async () => {
    const first = rerank(await publish(everyone()))
    const reversed = rerank(await publish([...everyone()].reverse()))
    expect(reversed.order).toEqual(first.order)

    // Next publication: the rows exist, ids are kept (ON CONFLICT DO UPDATE).
    const second = rerank(await publish([...everyone()].reverse()), first.ids)
    expect(second.order).toEqual(first.order)
    expect(new Set(second.order).size).toBe(second.order.length)
  })

  it('keeps idle rows last even when they already hold the smallest ids in the table', async () => {
    // Today's board already ranks idle accounts (e.g. bybit rows with a 0%
    // drawdown). They keep their old, small ids; rows ranked for the first
    // time get larger ones. A shared score would put the old idle rows first.
    const existingIds = new Map(idleRows().map((row, index) => [row.source_trader_id, index + 1]))
    const { order } = rerank(await publish(everyone()), existingIds)
    const firstIdle = order.findIndex(isIdleId)
    expect(firstIdle).toBe(12)
    expect(order.slice(firstIdle).every(isIdleId)).toBe(true)
  })

  it('idle rows do not shape the percentiles of the rows that are scored', async () => {
    const withIdle = byId(await publishedCohort(everyone(), 'roi_pnl'))
    const withoutIdle = byId(
      await publishedCohort([...losing(), ...profitable(), ...oneSided()], 'roi_pnl')
    )
    for (const [id, row] of withoutIdle) {
      expect(withIdle.get(id)!.arena_score).toBe(row.arena_score)
      expect(withIdle.get(id)!.score_factors).toEqual(row.score_factors)
    }
  })

  it('a row with a result in only one of ROI and PnL is scored, not idle', async () => {
    const rows = byId(await publishedCohort(everyone(), 'roi_pnl'))
    for (const id of ['roi-zero-pnl-positive', 'roi-positive-pnl-zero']) {
      expect(rows.get(id)!.score_factors).not.toHaveProperty('idle_window')
      expect(rows.get(id)!.arena_score!).toBeGreaterThan(MIN_RANKED_ARENA_SCORE)
    }
  })

  it('decides "is 0" at the precision the row is stored with', async () => {
    // roi numeric(12,4), pnl numeric(18,2): these are written as 0.0000 / 0.00.
    expect(isIdleWindowRow({ roi: 0.00004, pnl: 0.004 })).toBe(true)
    expect(isIdleWindowRow({ roi: -0.00004, pnl: -0.004 })).toBe(true)
    expect(isIdleWindowRow({ roi: 0, pnl: 0 })).toBe(true)
    // The smallest values that survive rounding are performance.
    expect(isIdleWindowRow({ roi: 0.0001, pnl: 0 })).toBe(false)
    expect(isIdleWindowRow({ roi: 0, pnl: 0.01 })).toBe(false)
    expect(isIdleWindowRow({ roi: 0, pnl: -0.01 })).toBe(false)
    expect(isIdleWindowRow({ roi: 0, pnl: null })).toBe(false)

    const rows = byId(
      await publishedCohort(
        [
          ...everyone(),
          traderRow('dust', { roi: 0.00004, pnl: 0.004, win_rate: 80, max_drawdown: 1 }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.get('dust')).toMatchObject({
      arena_score: MIN_RANKED_ARENA_SCORE,
      score_factors: { idle_window: true },
    })
    // What is written for it reads as ROI 0, PnL 0.
    const verdict = classifyPublishableRow(rows.get('dust')!, 'roi_pnl')
    expect(verdict).toMatchObject({ row: { roi: 0, pnl: 0, arena_score: 0.01 } })
  })

  it("'four_metrics' has no idle rule: the rows are scored as before", async () => {
    const rows = byId(await publishedCohort(everyone(), 'four_metrics'))
    // Only complete rows are ranked, and an idle one is scored like any other.
    const idle = rows.get('idle-with-risk-00')!
    expect(idle.score_factors).not.toHaveProperty('idle_window')
    expect(idle.arena_score!).toBeGreaterThan(MIN_ACTIVE_ARENA_SCORE)
    expect(rows.has('idle-none-00')).toBe(false)
  })

  it('the written idle row satisfies the database row policy shape', async () => {
    const written = await publish(everyone())
    for (const row of written.filter((entry) => isIdleId(entry.source_trader_id))) {
      // 0 < arena_score <= 100, label matches the columns, ROI and PnL present.
      expect(row.arena_score).toBe(0.01)
      expect(row.roi).toBe(0)
      expect(row.pnl).toBe(0)
      expect(row.score_completeness).toBe(
        row.win_rate !== null && row.max_drawdown !== null
          ? 'full'
          : row.win_rate !== null || row.max_drawdown !== null
            ? 'partial'
            : 'minimal'
      )
      expect(row.score_factors).toMatchObject({ idle_window: true })
    }
  })
})

describe('contradictory drawdown: a losing window with a 0% max drawdown', () => {
  const cohort = () => [
    traderRow('p1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('p2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('p3', { roi: 6, pnl: 900, win_rate: 48, max_drawdown: 35 }),
    traderRow('l1', { roi: -9, pnl: -300, win_rate: 41, max_drawdown: 44 }),
    traderRow('l2', { roi: -30, pnl: -4_000, win_rate: 30, max_drawdown: 60 }),
    // A profit with no drawdown in the window is possible: a real value (a 100%
    // win rate corroborates it; see the mdd_zero_unverified block otherwise).
    traderRow('profit-zero-dd', { roi: 12, pnl: 1_500, win_rate: 100, max_drawdown: 0 }),
    // A loss with no drawdown is not.
    traderRow('loss-zero-dd', { roi: -12, pnl: -1_500, win_rate: 60, max_drawdown: 0 }),
    // ROI is positive but the account lost money: still a losing window.
    traderRow('pnl-loss-zero-dd', { roi: 5.18, pnl: -67.64, win_rate: 52, max_drawdown: 0 }),
    // The same loss with an ordinary drawdown, for comparison.
    traderRow('loss-real-dd', { roi: -12, pnl: -1_500, win_rate: 60, max_drawdown: 20 }),
    // The same loss reporting no drawdown at all.
    traderRow('loss-no-dd', { roi: -12, pnl: -1_500, win_rate: 60, max_drawdown: null }),
    traderRow('idle-zero-dd', { roi: 0, pnl: 0, win_rate: 0, max_drawdown: 0 }),
  ]

  it('refuses the drawdown: no credit on that dimension, column empty, marked', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const refused = rows.get('loss-zero-dd')!

    expect(refused.max_drawdown).toBeNull()
    expect(refused.score_factors).toMatchObject({ drawdown: null, mdd_contradiction: true })
    // The label follows the columns the row now carries.
    expect(refused.score_completeness).toBe('partial')
    expect(refused.win_rate).toBe(60)

    // Scored exactly like the same loss that reports no drawdown at all...
    const missing = rows.get('loss-no-dd')!
    expect(refused.arena_score).toBe(missing.arena_score)
    expect({ ...refused.score_factors, mdd_contradiction: undefined }).toEqual({
      ...missing.score_factors,
      mdd_contradiction: undefined,
    })
    expect(missing.score_factors).not.toHaveProperty('mdd_contradiction')
    // ...and below the same loss with a real drawdown, which earns its percentile.
    expect(refused.arena_score!).toBeLessThan(rows.get('loss-real-dd')!.arena_score!)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[30D] Refused contradictory drawdowns (ROI < 0 or PnL < 0 with a 0% max drawdown; metric emptied, row kept): 2'
    )
  })

  it('refuses it when ROI is positive but PnL is negative', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const refused = rows.get('pnl-loss-zero-dd')!
    expect(refused.roi).toBe(5.18)
    expect(refused.pnl).toBe(-67.64)
    expect(refused.max_drawdown).toBeNull()
    expect(refused.score_factors).toMatchObject({ drawdown: null, mdd_contradiction: true })
    expect(refused.score_completeness).toBe('partial')
    expect(refused.win_rate).toBe(52)
  })

  it('still reads a 0% drawdown on a profitable row as the best drawdown', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const profitable = rows.get('profit-zero-dd')!
    expect(profitable.max_drawdown).toBe(0)
    expect(profitable.score_factors).toMatchObject({ drawdown: 1 })
    expect(profitable.score_factors).not.toHaveProperty('mdd_contradiction')
    expect(profitable.score_completeness).toBe('full')
  })

  it('leaves idle rows to the idle-window rule', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const idle = rows.get('idle-zero-dd')!
    expect(idle.max_drawdown).toBe(0)
    expect(idle.arena_score).toBe(MIN_RANKED_ARENA_SCORE)
    expect(idle.score_factors).toMatchObject({ idle_window: true })
    expect(idle.score_factors).not.toHaveProperty('mdd_contradiction')
  })

  it('does not let the refused 0 count as the best drawdown for anyone else', async () => {
    // With the refused row in the cohort, the profitable 0% row is still the
    // only one at the top of the drawdown dimension, and p1 (5%) is next.
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const without = byId(
      await publishedCohort(
        cohort().filter((row) => row.source_trader_id !== 'loss-zero-dd'),
        'roi_pnl'
      )
    )
    expect(rows.get('p1')!.score_factors!.drawdown).toBe(without.get('p1')!.score_factors!.drawdown)
  })

  it('reads both sides at the stored precision', () => {
    expect(hasContradictoryDrawdown({ roi: -12, pnl: -300, max_drawdown: 0 })).toBe(true)
    // max_drawdown is numeric(5,2): 0.004 is written as 0.00.
    expect(hasContradictoryDrawdown({ roi: -12, pnl: -300, max_drawdown: 0.004 })).toBe(true)
    expect(hasContradictoryDrawdown({ roi: -12, pnl: -300, max_drawdown: 0.01 })).toBe(false)
    // Either side losing is enough.
    expect(hasContradictoryDrawdown({ roi: -12, pnl: 40, max_drawdown: 0 })).toBe(true)
    expect(hasContradictoryDrawdown({ roi: 5, pnl: -40, max_drawdown: 0 })).toBe(true)
    expect(hasContradictoryDrawdown({ roi: -12, pnl: null, max_drawdown: 0 })).toBe(true)
    // roi is numeric(12,4): -0.00004 is written as 0.0000, not a loss.
    expect(hasContradictoryDrawdown({ roi: -0.00004, pnl: 0, max_drawdown: 0 })).toBe(false)
    expect(hasContradictoryDrawdown({ roi: -0.0001, pnl: 0, max_drawdown: 0 })).toBe(true)
    // pnl is numeric(18,2): -0.004 is written as 0.00, not a loss.
    expect(hasContradictoryDrawdown({ roi: 5, pnl: -0.004, max_drawdown: 0 })).toBe(false)
    expect(hasContradictoryDrawdown({ roi: 5, pnl: -0.01, max_drawdown: 0 })).toBe(true)
    // No loss on either side.
    expect(hasContradictoryDrawdown({ roi: 0, pnl: 0, max_drawdown: 0 })).toBe(false)
    expect(hasContradictoryDrawdown({ roi: 5, pnl: 40, max_drawdown: 0 })).toBe(false)
    expect(hasContradictoryDrawdown({ roi: 5, pnl: null, max_drawdown: 0 })).toBe(false)
    expect(hasContradictoryDrawdown({ roi: -12, pnl: -300, max_drawdown: null })).toBe(false)
  })

  it('writes the row with an empty drawdown that the row policy accepts', async () => {
    const scored = await publishedCohort(cohort(), 'roi_pnl')
    const verdict = classifyPublishableRow(
      scored.find((row) => row.source_trader_id === 'loss-zero-dd')!,
      'roi_pnl'
    )
    expect(verdict).toMatchObject({
      row: {
        max_drawdown: null,
        win_rate: 60,
        score_completeness: 'partial',
        score_factors: { mdd_contradiction: true, drawdown: null },
      },
    })
    expect(verdict).not.toHaveProperty('emptied')
  })

  it("'four_metrics' has no such rule", async () => {
    const rows = byId(await publishedCohort(cohort(), 'four_metrics'))
    const row = rows.get('loss-zero-dd')!
    expect(row.max_drawdown).toBe(0)
    expect(row.score_factors).not.toHaveProperty('mdd_contradiction')
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Refused contradictory drawdowns')
    )
  })
})

describe('sign_mismatch: ROI and PnL with opposite signs are counted, nothing else', () => {
  const base = () => [
    traderRow('p1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('p2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('l1', { roi: -9, pnl: -300, win_rate: 41, max_drawdown: 44 }),
    traderRow('idle', { roi: 0, pnl: 0, win_rate: null, max_drawdown: null }),
  ]
  const mismatched = () => [
    traderRow('roi-up-pnl-down', { source: 'toobit_futures', roi: 5.18, pnl: -67.64 }),
    traderRow('roi-up-pnl-down-2', { source: 'toobit_futures', roi: 2.86, pnl: -385.33 }),
    traderRow('roi-down-pnl-up', { source: 'bybit', roi: -4, pnl: 120 }),
    // Also a losing window with a 0% drawdown: the drawdown rule still applies.
    traderRow('mismatch-zero-dd', { source: 'bybit', roi: 1.6, pnl: -40, max_drawdown: 0 }),
  ]
  const signMismatchLogs = () =>
    mockLogger.warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('sign_mismatch'))

  it('logs the count per source', async () => {
    await publishedCohort([...base(), ...mismatched()], 'roi_pnl')
    expect(signMismatchLogs()).toEqual([
      '[30D] sign_mismatch (ROI and PnL have opposite signs; counted only, rows ranked unchanged): 4 {"bybit":2,"toobit_futures":2}',
    ])
  })

  it('does not change whether or how the rows are ranked', async () => {
    const rows = byId(await publishedCohort([...base(), ...mismatched()], 'roi_pnl'))
    for (const id of ['roi-up-pnl-down', 'roi-up-pnl-down-2', 'roi-down-pnl-up']) {
      const row = rows.get(id)!
      expect(row.arena_score!).toBeGreaterThanOrEqual(MIN_ACTIVE_ARENA_SCORE)
      expect(row.max_drawdown).toBe(12)
      expect(row.win_rate).toBe(55)
      expect(row.score_completeness).toBe('full')
      // No new mark: only the count in the log.
      expect(Object.keys(row.score_factors!).sort()).toEqual([
        'consistency',
        'drawdown',
        'pnl',
        'roi',
        'sharpe',
      ])
    }
    // Scored exactly like rows with the same numbers would be: the same call
    // without the counting gives the same scores.
    expect(hasSignMismatch({ roi: 5.18, pnl: -67.64 })).toBe(true)
    // The row that is also a losing window with a 0% drawdown follows that rule.
    expect(rows.get('mismatch-zero-dd')).toMatchObject({
      max_drawdown: null,
      score_factors: { mdd_contradiction: true },
    })
  })

  it('is silent when no row has opposite signs', async () => {
    await publishedCohort(base(), 'roi_pnl')
    expect(signMismatchLogs()).toEqual([])
  })

  it('reads both signs at the stored precision, and zero is not a sign', () => {
    expect(hasSignMismatch({ roi: 5, pnl: -1 })).toBe(true)
    expect(hasSignMismatch({ roi: -5, pnl: 1 })).toBe(true)
    expect(hasSignMismatch({ roi: 5, pnl: 1 })).toBe(false)
    expect(hasSignMismatch({ roi: -5, pnl: -1 })).toBe(false)
    expect(hasSignMismatch({ roi: 0, pnl: -1 })).toBe(false)
    expect(hasSignMismatch({ roi: 5, pnl: 0 })).toBe(false)
    expect(hasSignMismatch({ roi: 5, pnl: null })).toBe(false)
    // Written as ROI 0.0000 / PnL 0.00: no sign.
    expect(hasSignMismatch({ roi: 0.00004, pnl: -1 })).toBe(false)
    expect(hasSignMismatch({ roi: 5, pnl: -0.004 })).toBe(false)
    expect(hasSignMismatch({ roi: 0.0001, pnl: -0.01 })).toBe(true)
  })

  it('does not count rows the outlier rule already excludes for a large opposite-sign pair', async () => {
    // markOutliers: PnL < -500 with ROI > 50 (and the reverse) is an outlier
    // and never reaches the cohort.
    const rows = byId(
      await publishedCohort(
        [
          ...base(),
          traderRow('outlier-up-down', { source: 'xt', roi: 60, pnl: -800 }),
          traderRow('outlier-down-up', { source: 'xt', roi: -60, pnl: 800 }),
          traderRow('small-mismatch', { source: 'xt', roi: 3, pnl: -20 }),
        ],
        'roi_pnl'
      )
    )
    expect(rows.has('outlier-up-down')).toBe(false)
    expect(rows.has('outlier-down-up')).toBe(false)
    expect(rows.has('small-mismatch')).toBe(true)
    expect(signMismatchLogs()).toEqual([
      '[30D] sign_mismatch (ROI and PnL have opposite signs; counted only, rows ranked unchanged): 1 {"xt":1}',
    ])
  })

  it("'four_metrics' logs nothing about it", async () => {
    await publishedCohort([...base(), ...mismatched()], 'four_metrics')
    expect(signMismatchLogs()).toEqual([])
  })
})

describe('mdd_zero_unverified: a 0% drawdown that the win rate does not corroborate', () => {
  const cohort = () => [
    traderRow('p1', { roi: 80, pnl: 500_000, win_rate: 70, max_drawdown: 5 }),
    traderRow('p2', { roi: 20, pnl: 20_000, win_rate: 55, max_drawdown: 15 }),
    traderRow('p3', { roi: 6, pnl: 900, win_rate: 48, max_drawdown: 35 }),
    traderRow('l1', { roi: -9, pnl: -300, win_rate: 41, max_drawdown: 44 }),
    // Same ROI, PnL and win rate; only the drawdown differs.
    traderRow('zero-wr-below', { roi: 40, pnl: 60_000, win_rate: 92.56, max_drawdown: 0 }),
    traderRow('null-dd', { roi: 40, pnl: 60_000, win_rate: 92.56, max_drawdown: null }),
    traderRow('small-real-dd', { roi: 40, pnl: 60_000, win_rate: 92.56, max_drawdown: 0.5 }),
    traderRow('zero-wr-null', { roi: 40, pnl: 60_000, win_rate: null, max_drawdown: 0 }),
    traderRow('zero-wr-100', { roi: 40, pnl: 60_000, win_rate: 100, max_drawdown: 0 }),
    // Stored as 0.00 drawdown, so it is a zero.
    traderRow('rounds-to-zero', {
      source: 'binance_futures',
      roi: 40,
      pnl: 60_000,
      win_rate: 86.49,
      max_drawdown: 0.004,
    }),
    traderRow('loss-zero-dd', { roi: -12, pnl: -1_500, win_rate: 60, max_drawdown: 0 }),
    traderRow('idle-zero-dd', { roi: 0, pnl: 0, win_rate: 50, max_drawdown: 0 }),
  ]

  it('keeps and shows the value, scores the drawdown neutrally, marks the row', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    for (const id of ['zero-wr-below', 'zero-wr-null', 'rounds-to-zero']) {
      const row = rows.get(id)!
      expect(row.max_drawdown).not.toBeNull()
      expect(row.score_factors).toMatchObject({ drawdown: null, mdd_zero_unverified: true })
      expect(row.score_factors).not.toHaveProperty('mdd_contradiction')
    }
    expect(rows.get('zero-wr-below')).toMatchObject({ max_drawdown: 0, score_completeness: 'full' })
    expect(rows.get('zero-wr-null')).toMatchObject({
      max_drawdown: 0,
      score_completeness: 'partial',
    })
    expect(rows.get('rounds-to-zero')!.max_drawdown).toBe(0.004)
  })

  it('invariant: null drawdown <= neutral zero <= real small drawdown', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const missing = rows.get('null-dd')!.arena_score!
    const neutral = rows.get('zero-wr-below')!.arena_score!
    const real = rows.get('small-real-dd')!.arena_score!
    expect(missing).toBeLessThan(neutral)
    expect(neutral).toBeLessThan(real)
  })

  it('scores a zero with a 100% win rate as the real best drawdown', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    const row = rows.get('zero-wr-100')!
    expect(row.score_factors).toMatchObject({ drawdown: 1 })
    expect(row.score_factors).not.toHaveProperty('mdd_zero_unverified')
  })

  it('leaves the contradictory-drawdown rule first and idle rows unflagged', async () => {
    const rows = byId(await publishedCohort(cohort(), 'roi_pnl'))
    expect(rows.get('loss-zero-dd')!.max_drawdown).toBeNull()
    expect(rows.get('loss-zero-dd')!.score_factors).toMatchObject({ mdd_contradiction: true })
    expect(rows.get('loss-zero-dd')!.score_factors).not.toHaveProperty('mdd_zero_unverified')
    expect(rows.get('idle-zero-dd')!.score_factors).toMatchObject({ idle_window: true })
    expect(rows.get('idle-zero-dd')!.score_factors).not.toHaveProperty('mdd_zero_unverified')
  })

  it('logs the count per source', async () => {
    await publishedCohort(cohort(), 'roi_pnl')
    expect(mockLogger.info).toHaveBeenCalledWith(
      '[30D] mdd_zero_unverified (0% drawdown with a win rate below 100% or unknown; value kept, drawdown scored neutrally): 3 {"binance_futures":1,"bybit":2}'
    )
  })

  it('reads both sides at the stored precision', () => {
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: 0.004, win_rate: 50 })).toBe(true)
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: 0.005, win_rate: 50 })).toBe(false)
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: 0, win_rate: 99.994 })).toBe(true)
    // 99.996 is stored as 100.00: self-consistent.
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: 0, win_rate: 99.996 })).toBe(false)
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: 0, win_rate: null })).toBe(true)
    expect(hasUnverifiedZeroDrawdown({ max_drawdown: null, win_rate: 50 })).toBe(false)
  })

  it("'four_metrics' output is unchanged by the rule", async () => {
    const rows = await publishedCohort(cohort(), 'four_metrics')
    // Exactly the signed historical contract over the same inputs, bit for bit.
    const expected = computeArenaScoresV4(
      rows.map((t) => ({
        roi: t.roi,
        pnl: t.pnl,
        maxDrawdown: t.max_drawdown,
        winRate: t.win_rate,
        sharpeRatio: t.sharpe_ratio,
        profitFactor: t.profit_factor,
        tradesCount: t.trades_count,
        source: t.source,
      })),
      '30D'
    )
    expect(rows.map((t) => [t.arena_score, t.score_factors])).toEqual(
      expected.map((r) => [r.totalScore, r.factors])
    )
    for (const row of rows) expect(row.score_factors).not.toHaveProperty('mdd_zero_unverified')
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('mdd_zero_unverified'))
  })
})
