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
import { classifyPublishableRow, orderRowsForWrite } from '../publish-season'
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

  it('a 0% drawdown is the best drawdown; a missing one scores nothing', async () => {
    const rows = byId(
      await publishedCohort(
        [
          ...others(),
          traderRow('dd-zero', { max_drawdown: 0 }),
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

describe('zero-return accounts rank at the bottom, in a stable order', () => {
  // The shape production has after the relaxation: most new rows are idle
  // accounts with ROI 0, PnL 0 and no risk metrics.
  const zeroRows = () =>
    Array.from({ length: 60 }, (_, i) =>
      traderRow(`zero-${String(i).padStart(2, '0')}`, {
        source: 'xt',
        roi: 0,
        pnl: 0,
        win_rate: null,
        max_drawdown: null,
      })
    )
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
    traderRow('loss-minimal-2', { roi: -70, pnl: -5_000, win_rate: null, max_drawdown: null }),
  ]

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

  it('every profitable trader ranks above every zero-return account', async () => {
    const written = await publish([...zeroRows(), ...losing(), ...profitable()])
    const { order } = rerank(written)

    expect(order).toHaveLength(70)
    const position = new Map(order.map((id, index) => [id, index]))
    const lastProfitable = Math.max(
      ...profitable().map((row) => position.get(row.source_trader_id)!)
    )
    const firstZero = Math.min(...zeroRows().map((row) => position.get(row.source_trader_id)!))
    expect(lastProfitable).toBeLessThan(firstZero)

    // The zero-return accounts are one contiguous block: nothing else is
    // interleaved by the id tie-break.
    const zeroPositions = zeroRows()
      .map((row) => position.get(row.source_trader_id)!)
      .sort((a, b) => a - b)
    expect(zeroPositions[zeroPositions.length - 1] - zeroPositions[0]).toBe(59)
    // ...and inside the block the order is the identity order, not arrival order.
    expect(order.slice(zeroPositions[0], zeroPositions[0] + 60)).toEqual(
      zeroRows().map((row) => row.source_trader_id)
    )

    // All of them share one score, at or above the display floor.
    const zeroScores = new Set(
      written
        .filter((row) => row.source_trader_id.startsWith('zero-'))
        .map((row) => row.arena_score)
    )
    expect(zeroScores.size).toBe(1)
    expect([...zeroScores][0]).toBeGreaterThanOrEqual(MIN_RANKED_ARENA_SCORE)
  })

  it('places losing traders by the formula, with no extra rule', async () => {
    const written = await publish([...zeroRows(), ...losing(), ...profitable()])
    const { order } = rerank(written)
    const position = new Map(order.map((id, index) => [id, index]))
    const firstZero = position.get('zero-00')!
    const lastZero = position.get('zero-59')!

    // A losing trader whose drawdown and win rate earn percentile credit ranks
    // above the idle block: those two dimensions outweigh a slightly lower ROI
    // percentile.
    expect(position.get('loss-full-1')!).toBeLessThan(firstZero)
    // Having the metrics is not credit by itself: this one has the worst
    // drawdown and the worst win rate of the cohort (both factors 0) and a
    // lower ROI percentile than a zero-return account, so it ranks below it.
    expect(position.get('loss-full-2')!).toBeGreaterThan(lastZero)
    // A losing trader with nothing but ROI and PnL has a lower ROI percentile
    // than a zero-return account and no other credit: below the block too.
    expect(position.get('loss-minimal-1')!).toBeGreaterThan(lastZero)
    expect(position.get('loss-minimal-2')!).toBeGreaterThan(lastZero)
    // The worst loss is last, at the floor.
    expect(order[order.length - 1]).toBe('loss-minimal-2')
    expect(written.find((row) => row.source_trader_id === 'loss-minimal-2')!.arena_score).toBe(
      MIN_RANKED_ARENA_SCORE
    )
  })

  it('gives the same ranks whatever order the rows arrive in, and on republication', async () => {
    const forward = [...zeroRows(), ...losing(), ...profitable()]
    const first = rerank(await publish(forward))
    const reversed = rerank(await publish([...forward].reverse()))
    expect(reversed.order).toEqual(first.order)

    // Next publication: the rows exist, ids are kept (ON CONFLICT DO UPDATE).
    const second = rerank(await publish([...forward].reverse()), first.ids)
    expect(second.order).toEqual(first.order)
    // Ranks are a dense 1..n with no duplicates however many rows tie.
    expect(new Set(second.order).size).toBe(second.order.length)
  })

  it('when the idle block is the whole bottom of the cohort it sits on the 0.01 floor together', async () => {
    const written = await publish([...zeroRows(), ...profitable()])
    const zeroScores = written
      .filter((row) => row.source_trader_id.startsWith('zero-'))
      .map((row) => row.arena_score)
    expect(new Set(zeroScores)).toEqual(new Set([MIN_RANKED_ARENA_SCORE]))
    const { order } = rerank(written)
    expect(order.slice(0, 6).sort()).toEqual(
      profitable()
        .map((row) => row.source_trader_id)
        .sort()
    )
    expect(order.slice(6)).toEqual(zeroRows().map((row) => row.source_trader_id))
  })
})
