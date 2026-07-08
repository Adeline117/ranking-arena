import { computeArenaScoreV4, ARENA_V4_CONFIG, type TraderScoreInputV4 } from '../arena-score'

// Baseline: a strong all-around CEX trader (all metrics present).
const strong: TraderScoreInputV4 = {
  roi: 428,
  pnl: 12_090_000,
  maxDrawdown: 22,
  winRate: 62,
  sharpeRatio: 6.6,
  profitFactor: 3,
  tradesCount: 500,
}

describe('computeArenaScoreV4 — invariants', () => {
  it('score ∈ [0,100], quality ∈ [0,1], confidence ∈ [0.35,1]', () => {
    const r = computeArenaScoreV4(strong, '90D')
    expect(r.totalScore).toBeGreaterThanOrEqual(0)
    expect(r.totalScore).toBeLessThanOrEqual(100)
    expect(r.quality).toBeGreaterThanOrEqual(0)
    expect(r.quality).toBeLessThanOrEqual(1)
    expect(r.confidence).toBeGreaterThanOrEqual(ARENA_V4_CONFIG.CONF_FLOOR)
    expect(r.confidence).toBeLessThanOrEqual(1)
  })

  it('a strong all-around trader scores high (>75)', () => {
    expect(computeArenaScoreV4(strong, '90D').totalScore).toBeGreaterThan(75)
  })

  it('ROI + PnL contribute 60% of weight when all factors present', () => {
    const W = ARENA_V4_CONFIG.W
    expect(W.roi + W.pnl).toBeCloseTo(0.6, 6)
    expect(W.roi + W.pnl + W.dd + W.sharpe + W.con).toBeCloseTo(1.0, 6)
  })
})

describe('anti-gaming: low-principal high-ROI toy wallet', () => {
  it('a $200-PnL / 10000%-ROI wallet with no risk data scores LOW (< 40)', () => {
    // The classic exploit: tiny account, absurd ROI%, no track record.
    const toy: TraderScoreInputV4 = {
      roi: 10000,
      pnl: 200,
      maxDrawdown: null,
      winRate: null,
      sharpeRatio: null,
      profitFactor: null,
      tradesCount: 3,
    }
    const r = computeArenaScoreV4(toy, '90D')
    // PnL floor (f_pnl≈0) + low confidence (3 trades, no risk metrics) crush it.
    expect(r.totalScore).toBeLessThan(40)
    expect(r.factors.pnl).toBeLessThan(0.1)
  })

  it('ROI is compressed: 300% and 10000% give nearly-equal ROI factor', () => {
    const at300 = computeArenaScoreV4({ ...strong, roi: 300 }, '90D').factors.roi
    const at10000 = computeArenaScoreV4({ ...strong, roi: 10000 }, '90D').factors.roi
    // tanh compression → both high, close to each other (kills ROI domination).
    // 300% → 0.76, 10000% → 1.0: a ~0.24 gap on a 0.30-weight factor = ~0.07 score.
    expect(at10000 - at300).toBeLessThan(0.25)
    expect(at300).toBeGreaterThan(0.7)
  })
})

describe('drawdown is penalized (V3 ignored it entirely)', () => {
  it('a −90% MDD wallet scores well below the same trader at −15% MDD', () => {
    const clean = computeArenaScoreV4({ ...strong, maxDrawdown: 15 }, '90D').totalScore
    const blown = computeArenaScoreV4({ ...strong, maxDrawdown: 90 }, '90D').totalScore
    expect(clean).toBeGreaterThan(blown)
    expect(clean - blown).toBeGreaterThan(3) // meaningful gap
  })

  it('drawdown factor: 10% → ~1.0, 70%+ → ~0', () => {
    const good = computeArenaScoreV4({ ...strong, maxDrawdown: 10 }, '90D').factors.drawdown
    const terrible = computeArenaScoreV4({ ...strong, maxDrawdown: 80 }, '90D').factors.drawdown
    expect(good).toBeGreaterThan(0.95)
    expect(terrible).toBe(0)
  })
})

describe('statistical honesty (confidence layer)', () => {
  it('a tiny sample (5 trades) scores below a large sample (500), all else equal', () => {
    const many = computeArenaScoreV4({ ...strong, tradesCount: 500 }, '90D').totalScore
    const few = computeArenaScoreV4({ ...strong, tradesCount: 5 }, '90D').totalScore
    expect(many).toBeGreaterThan(few)
  })

  it('missing risk metrics lowers confidence vs a fully-populated trader', () => {
    const full = computeArenaScoreV4(strong, '90D').confidence
    const sparse = computeArenaScoreV4(
      { ...strong, maxDrawdown: null, sharpeRatio: null, profitFactor: null },
      '90D'
    ).confidence
    expect(full).toBeGreaterThan(sparse)
  })

  it('0 max-drawdown / 0 win-rate treated as MISSING, not as perfect (no fake reward)', () => {
    // Exchange reports 0 when it has no data — must NOT count as a flawless 0% drawdown.
    const zeroMdd = computeArenaScoreV4({ ...strong, maxDrawdown: 0 }, '90D')
    expect(zeroMdd.factors.drawdown).toBeNull()
  })
})

describe('big earner surfaces (V3 buried low-ROI whales)', () => {
  it('an $8M-PnL / 83%-ROI clean trader still scores well (>65)', () => {
    // V3 scored this ~54 because ROI% was "only" 83%. Absolute earnings + clean
    // risk should keep it high under v4.
    const whale: TraderScoreInputV4 = {
      roi: 83,
      pnl: 8_260_000,
      maxDrawdown: 13,
      winRate: 55,
      sharpeRatio: 8.7,
      profitFactor: 2.5,
      tradesCount: 500,
    }
    expect(computeArenaScoreV4(whale, '90D').totalScore).toBeGreaterThan(65)
  })
})

describe('period-aware ROI compression', () => {
  it('same ROI yields a higher factor on shorter timeframes (smaller divisor)', () => {
    const roi = 90
    const f7 = computeArenaScoreV4({ ...strong, roi }, '7D').factors.roi
    const f90 = computeArenaScoreV4({ ...strong, roi }, '90D').factors.roi
    expect(f7).toBeGreaterThan(f90) // 90% ROI is exceptional in 7d, ordinary in 90d
  })
})
