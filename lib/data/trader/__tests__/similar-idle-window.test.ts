/**
 * Similar traders never include idle-window rows (no ROI and no PnL in the
 * period). The fake below applies the query's predicates to in-memory rows,
 * so the test fails if the idle predicate is dropped from either lookup.
 */
jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { fetchSimilarTraders } from '../similar'

type Row = Record<string, unknown>

function row(overrides: Row = {}): Row {
  return {
    source: 'binance_futures',
    source_trader_id: 'similar-1',
    season_id: '90D',
    rank: 2,
    arena_score: 8,
    roi: 10,
    pnl: 4000,
    win_rate: 60,
    max_drawdown: 8,
    followers: 10,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    idle_window: false,
    ...overrides,
  }
}

function idleRow(id: string, rank: number): Row {
  return row({
    source_trader_id: id,
    rank,
    arena_score: 0.01,
    roi: 0,
    pnl: 0,
    win_rate: null,
    max_drawdown: null,
    score_completeness: 'minimal',
    idle_window: true,
  })
}

/** Applies eq / neq / gte / lte / not-null / limit to the given view rows. */
function viewOf(rows: Row[]) {
  const from = jest.fn(() => {
    const tests: ((candidate: Row) => boolean)[] = []
    let max = Infinity
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      abortSignal: () => builder,
      eq: (column: string, value: unknown) => {
        tests.push((candidate) => candidate[column] === value)
        return builder
      },
      neq: (column: string, value: unknown) => {
        tests.push((candidate) => candidate[column] !== value)
        return builder
      },
      not: (column: string) => {
        tests.push((candidate) => candidate[column] != null)
        return builder
      },
      gte: (column: string, bound: number) => {
        tests.push((candidate) => {
          const value = candidate[column]
          return typeof value === 'number' && value >= bound
        })
        return builder
      },
      lte: (column: string, bound: number) => {
        tests.push((candidate) => {
          const value = candidate[column]
          return typeof value === 'number' && value <= bound
        })
        return builder
      },
      limit: (count: number) => {
        max = count
        return builder
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: rows
            .filter((candidate) => tests.every((test) => test(candidate)))
            // The row's flag is a view column the lookup filters on, not one
            // it selects.
            .map(({ idle_window: _idle, ...selected }) => selected)
            .slice(0, max),
          error: null,
        }).then(resolve),
    }
    return builder
  })
  return { from }
}

const ACTIVE = [
  row({ source_trader_id: 'active-1', rank: 2, arena_score: 9, roi: 12 }),
  row({ source_trader_id: 'active-2', rank: 3, arena_score: 6, roi: 4 }),
]
const IDLE = [idleRow('idle-1', 900), idleRow('idle-2', 901)]

describe('similar traders exclude idle-window rows', () => {
  it('by score: a low-score trader is not matched with 0.01-score idle rows', async () => {
    // Score 5 → range [-5, 15], which contains the idle rows' 0.01.
    const result = await fetchSimilarTraders(
      viewOf([...ACTIVE, ...IDLE]) as never,
      'binance_futures',
      'current-trader',
      5,
      null
    )

    expect(result.map((trader) => trader.traderKey)).toEqual(['active-1', 'active-2'])
  })

  it('by ROI: an ROI near zero is not matched with ROI-0 idle rows', async () => {
    // ROI 3 → range [-17, 23], which contains the idle rows' 0.
    const result = await fetchSimilarTraders(
      viewOf([...ACTIVE, ...IDLE]) as never,
      'binance_futures',
      'current-trader',
      null,
      3
    )

    expect(result.map((trader) => trader.traderKey)).toEqual(['active-1', 'active-2'])
  })

  it('returns the same traders as before under the old rule (full rows, none idle)', async () => {
    // Same view without the predicate being able to remove anything: the
    // result is exactly the rows the range selects, as before the change.
    const byScore = await fetchSimilarTraders(
      viewOf(ACTIVE) as never,
      'binance_futures',
      'current-trader',
      5,
      null
    )
    const byRoi = await fetchSimilarTraders(
      viewOf(ACTIVE) as never,
      'binance_futures',
      'current-trader',
      null,
      3
    )

    expect(byScore.map((trader) => [trader.traderKey, trader.arenaScore, trader.roi])).toEqual([
      ['active-1', 9, 12],
      ['active-2', 6, 4],
    ])
    expect(byRoi.map((trader) => trader.traderKey)).toEqual(['active-1', 'active-2'])
  })
})
