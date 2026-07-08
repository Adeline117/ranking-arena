import {
  computeArenaScoresV4,
  percentRanks,
  ARENA_V4_CONFIG,
  type TraderScoreInputV4,
} from '../arena-score'

// A cohort with distinct archetypes + filler, so percentiles are meaningful.
// Index map is asserted below by construction order.
const STRONG = 0 // big PnL, strong ROI, low MDD, high Sharpe, big sample
const WHALE = 1 // huge PnL, low ROI%, clean risk
const TOY = 2 // tiny PnL, absurd ROI%, no risk data, 3 trades (the exploit)
const BLOWN = 3 // decent PnL but 90% drawdown, 0 trades
const SMALL_PRO = 4 // small PnL but elite Sharpe/MDD, many trades

function cohort(): TraderScoreInputV4[] {
  const base: TraderScoreInputV4[] = [
    {
      roi: 428,
      pnl: 12_000_000,
      maxDrawdown: 22,
      winRate: 62,
      sharpeRatio: 6.6,
      profitFactor: 3,
      tradesCount: 500,
    }, // STRONG
    {
      roi: 63,
      pnl: 24_000_000,
      maxDrawdown: 20,
      winRate: 55,
      sharpeRatio: 6.9,
      profitFactor: 2,
      tradesCount: 640,
    }, // WHALE
    {
      roi: 10000,
      pnl: 200,
      maxDrawdown: null,
      winRate: null,
      sharpeRatio: null,
      profitFactor: null,
      tradesCount: 3,
    }, // TOY
    {
      roi: 800,
      pnl: 1_400_000,
      maxDrawdown: 90,
      winRate: null,
      sharpeRatio: null,
      profitFactor: null,
      tradesCount: 0,
    }, // BLOWN
    {
      roi: 180,
      pnl: 50_000,
      maxDrawdown: 3,
      winRate: 65,
      sharpeRatio: 9.0,
      profitFactor: 4,
      tradesCount: 300,
    }, // SMALL_PRO
  ]
  // filler to populate the distribution (median-ish traders)
  for (let i = 0; i < 15; i++) {
    base.push({
      roi: 20 + i * 10,
      pnl: 1000 + i * 5000,
      maxDrawdown: 25 + i,
      winRate: 45 + i,
      sharpeRatio: 0.5 + i * 0.2,
      profitFactor: 1 + i * 0.1,
      tradesCount: 40 + i * 20,
    })
  }
  return base
}

describe('computeArenaScoresV4 — batch invariants', () => {
  const r = computeArenaScoresV4(cohort(), '90D')
  it('returns one result per input, all scores in [0,100]', () => {
    expect(r).toHaveLength(20)
    for (const x of r) {
      expect(x.totalScore).toBeGreaterThanOrEqual(0)
      expect(x.totalScore).toBeLessThanOrEqual(100)
    }
  })
  it('empty cohort → empty array', () => {
    expect(computeArenaScoresV4([], '90D')).toEqual([])
  })
  it('earnings (ROI+PnL) = 0.50, skill (dd+sharpe+con) = 0.50 (owner-locked, backtest-calibrated)', () => {
    const W = ARENA_V4_CONFIG.W
    expect(W.pnl + W.roi).toBeCloseTo(0.5, 6)
    expect(W.dd + W.sharpe + W.con).toBeCloseTo(0.5, 6)
    expect(W.pnl + W.roi + W.dd + W.sharpe + W.con).toBeCloseTo(1.0, 6)
  })
})

describe('ranking behavior on real archetypes', () => {
  const r = computeArenaScoresV4(cohort(), '90D')
  it('big earners (STRONG/WHALE) far outrank the toy-wallet exploit', () => {
    expect(r[STRONG].totalScore).toBeGreaterThan(r[TOY].totalScore + 30)
    expect(r[WHALE].totalScore).toBeGreaterThan(r[TOY].totalScore + 30)
  })
  it('the -90% drawdown / 0-trade wallet ranks below the strong trader', () => {
    expect(r[STRONG].totalScore).toBeGreaterThan(r[BLOWN].totalScore)
  })
  it('STRONG (clean risk) beats WHALE (bigger PnL but lower ROI% + weaker risk)', () => {
    // earnings matter (both high) but skill 30% tips it to the cleaner trader
    expect(r[STRONG].totalScore).toBeGreaterThanOrEqual(r[WHALE].totalScore)
  })
  it('SMALL_PRO (elite risk, tiny PnL) still scores respectably (not buried)', () => {
    // it should beat the toy wallet and the blown-up wallet on skill+confidence
    expect(r[SMALL_PRO].totalScore).toBeGreaterThan(r[TOY].totalScore)
    expect(r[SMALL_PRO].totalScore).toBeGreaterThan(r[BLOWN].totalScore)
  })
  it('factors exposed for the score breakdown (percentile dims + pnl magnitude)', () => {
    const f = r[STRONG].factors
    expect(f.pnl).toBeGreaterThan(0.8) // $12M → near top of the log-magnitude range
    expect(f.drawdown).not.toBeNull()
    expect(f.sharpe).not.toBeNull()
  })
})

describe('percentRanks helper', () => {
  it('min→0, max→1, nulls preserved', () => {
    expect(percentRanks([10, 20, 30])).toEqual([0, 0.5, 1])
    expect(percentRanks([5, null, 15])).toEqual([0, null, 1])
  })
  it('all-null → all-null; single value → 1', () => {
    expect(percentRanks([null, null])).toEqual([null, null])
    expect(percentRanks([42])).toEqual([1])
  })
})
