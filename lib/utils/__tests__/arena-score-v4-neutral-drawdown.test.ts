import {
  computeArenaScoresV4,
  computeArenaScoresV4WithOptions,
  computeArenaScoresV5,
  type ArenaScoreV4Options,
  type TraderScoreInputV4,
} from '../arena-score'

const publication: ArenaScoreV4Options = {
  zeroRiskMetricsAreKnown: true,
  missingRiskPolicy: 'zero',
  neutralDrawdownInputs: true,
}

const base: TraderScoreInputV4 = {
  roi: 200,
  pnl: 9_000,
  maxDrawdown: 20,
  winRate: 90,
  sharpeRatio: null,
  profitFactor: null,
  tradesCount: null,
  source: 'binance_futures',
}

/** Spread-out cohort; the rows under test are prepended. */
const filler: TraderScoreInputV4[] = Array.from({ length: 40 }, (_, i) => ({
  ...base,
  roi: 5 + i * 10,
  pnl: 1_500 + i * 2_000,
  maxDrawdown: 0.5 + i * 2,
  winRate: 40 + i,
}))

/** One cohort: same ROI, PnL, win rate, Sharpe, trades; only the drawdown differs. */
function twins() {
  const missing = { ...base, maxDrawdown: null }
  const neutral = { ...base, maxDrawdown: 0, maxDrawdownNeutral: true }
  // Smallest real drawdown in the cohort => drawdown percentile 1.
  const smallReal = { ...base, maxDrawdown: 0.05 }
  const [m, n, s] = computeArenaScoresV4WithOptions(
    [missing, neutral, smallReal, ...filler],
    '7D',
    publication
  )
  return { m, n, s }
}

describe('neutral drawdown (maxDrawdownNeutral, publication options)', () => {
  it('takes the drawdown out of the row: factor null, weight out of the denominator', () => {
    const { n } = twins()
    expect(n.factors.drawdown).toBeNull()
    // PnL 0.3 + ROI 0.2 + consistency 0.1; no drawdown term, no drawdown weight.
    const f = n.factors
    expect(n.quality).toBeCloseTo((0.3 * f.pnl + 0.2 * f.roi + 0.1 * f.consistency!) / 0.6, 2)
  })

  it('invariant: missing <= neutral <= best real small drawdown (quality, composite, score)', () => {
    const { m, n, s } = twins()
    expect(m.quality).toBeLessThanOrEqual(n.quality)
    expect(n.quality).toBeLessThanOrEqual(s.quality)
    expect(m.quality * m.confidence).toBeLessThanOrEqual(n.quality * n.confidence)
    expect(n.quality * n.confidence).toBeLessThanOrEqual(s.quality * s.confidence)
    expect(m.totalScore).toBeLessThanOrEqual(n.totalScore)
    expect(n.totalScore).toBeLessThanOrEqual(s.totalScore)
    // Pinned numbers (reported with the change).
    expect([m.quality, n.quality, s.quality]).toEqual([0.33, 0.44, 0.58])
    expect([m.confidence, n.confidence, s.confidence]).toEqual([0.49, 0.49, 0.49])
    expect([m.totalScore, n.totalScore, s.totalScore]).toEqual([22.01, 54.35, 100])
    expect(s.factors.drawdown).toBe(1)
  })

  it('does not count a neutral drawdown as present data for confidence', () => {
    // Known trade counts, so the completeness term of confidence is not clamped.
    const known = { ...base, tradesCount: 400 }
    const rows = computeArenaScoresV4WithOptions(
      [
        { ...known, maxDrawdown: null },
        { ...known, maxDrawdown: 0, maxDrawdownNeutral: true },
        { ...known, maxDrawdown: 0.05 },
        ...filler,
      ],
      '7D',
      publication
    )
    expect(rows[1].confidence).toBe(rows[0].confidence)
    expect(rows[1].confidence).toBeLessThan(rows[2].confidence)
    expect(rows[0].totalScore).toBeLessThan(rows[1].totalScore)
    expect(rows[1].totalScore).toBeLessThan(rows[2].totalScore)
  })

  it('a neutral row stays out of the drawdown percentile cohort', () => {
    const withoutNeutral = computeArenaScoresV4WithOptions(filler, '7D', publication)
    const withNeutral = computeArenaScoresV4WithOptions(
      [{ ...base, maxDrawdown: 0, maxDrawdownNeutral: true }, ...filler],
      '7D',
      publication
    ).slice(1)
    expect(withNeutral.map((r) => r.factors.drawdown)).toEqual(
      withoutNeutral.map((r) => r.factors.drawdown)
    )
  })

  it('neutral can exceed a real drawdown twin only when that twin is below its own quality', () => {
    // A real drawdown with percentile p raises quality iff p > the neutral
    // quality: (num + 0.2p) / (den + 0.2) > num / den  <=>  p > num / den.
    const { n } = twins()
    const neutralQuality = n.quality
    // A real 50% drawdown (percentile 0.38 < neutral quality 0.44) scores lower.
    const mid = { ...base, maxDrawdown: 50 }
    const [neutral, real] = computeArenaScoresV4WithOptions(
      [{ ...base, maxDrawdown: 0, maxDrawdownNeutral: true }, mid, ...filler],
      '7D',
      publication
    )
    expect(real.factors.drawdown!).toBeLessThan(neutralQuality)
    expect(neutral.totalScore).toBeGreaterThan(real.totalScore)
  })

  it('ignores the flag without neutralDrawdownInputs (historical and roi_pnl-without-flag paths)', () => {
    const cohort = [{ ...base, maxDrawdown: 0, maxDrawdownNeutral: true }, ...filler]
    const plain = cohort.map(({ maxDrawdownNeutral: _flag, ...row }) => row)
    expect(computeArenaScoresV4(cohort, '7D')).toEqual(computeArenaScoresV4(plain, '7D'))
    expect(computeArenaScoresV5(cohort, '7D')).toEqual(computeArenaScoresV5(plain, '7D'))
    const noFlag = { zeroRiskMetricsAreKnown: true, missingRiskPolicy: 'zero' } as const
    expect(computeArenaScoresV4WithOptions(cohort, '7D', noFlag)).toEqual(
      computeArenaScoresV4WithOptions(plain, '7D', noFlag)
    )
    expect(computeArenaScoresV4WithOptions(cohort, '7D', noFlag)[0].factors.drawdown).toBe(1)
  })

  it('a flag on a null drawdown changes nothing (missing stays missing)', () => {
    const cohort = [{ ...base, maxDrawdown: null, maxDrawdownNeutral: true }, ...filler]
    const plain = [{ ...base, maxDrawdown: null }, ...filler]
    expect(computeArenaScoresV4WithOptions(cohort, '7D', publication)).toEqual(
      computeArenaScoresV4WithOptions(plain, '7D', publication)
    )
  })
})
