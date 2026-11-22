import {
  computeArenaScoresV4,
  computeArenaScoresV4WithOptions,
  computeArenaScoresV5,
  type TraderScoreInputV4,
} from '../arena-score'

const base: TraderScoreInputV4 = {
  roi: 20,
  pnl: 50_000,
  maxDrawdown: 20,
  winRate: 50,
  sharpeRatio: null,
  profitFactor: null,
  tradesCount: 120,
  source: 'bybit',
}

/** A cohort with spread-out risk values; index 0 is the row under test. */
function cohortWith(subject: Partial<TraderScoreInputV4>): TraderScoreInputV4[] {
  return [
    { ...base, ...subject },
    { ...base, roi: 5, pnl: 2_000, maxDrawdown: 5, winRate: 35 },
    { ...base, roi: 12, pnl: 9_000, maxDrawdown: 15, winRate: 48 },
    { ...base, roi: 40, pnl: 80_000, maxDrawdown: 30, winRate: 61 },
    { ...base, roi: 90, pnl: 400_000, maxDrawdown: 45, winRate: 72 },
    { ...base, roi: -15, pnl: -3_000, maxDrawdown: 60, winRate: 20 },
  ]
}

describe('computeArenaScoresV4WithOptions: only null is missing', () => {
  const known = { zeroRiskMetricsAreKnown: true } as const

  it('reads a 0% drawdown as the best drawdown in the cohort, not as missing', () => {
    const [subject] = computeArenaScoresV4WithOptions(cohortWith({ maxDrawdown: 0 }), '30D', known)
    expect(subject.factors.drawdown).toBe(1)
  })

  it('reads a 0% win rate as the worst consistency in the cohort, not as missing', () => {
    const [subject] = computeArenaScoresV4WithOptions(cohortWith({ winRate: 0 }), '30D', known)
    expect(subject.factors.consistency).toBe(0)
  })

  it('keeps null as the only missing value', () => {
    const [subject] = computeArenaScoresV4WithOptions(
      cohortWith({ maxDrawdown: null, winRate: null }),
      '30D',
      known
    )
    expect(subject.factors.drawdown).toBeNull()
    expect(subject.factors.consistency).toBeNull()
  })

  it('scores a 0% drawdown above the same trader with a 20% drawdown', () => {
    const zero = computeArenaScoresV4WithOptions(cohortWith({ maxDrawdown: 0 }), '30D', known)[0]
    const twenty = computeArenaScoresV4WithOptions(cohortWith({ maxDrawdown: 20 }), '30D', known)[0]
    expect(zero.quality).toBeGreaterThan(twenty.quality)
    expect(zero.totalScore).toBeGreaterThan(twenty.totalScore)
  })

  it('scores a 0% win rate below the same trader with a 50% win rate', () => {
    const zero = computeArenaScoresV4WithOptions(cohortWith({ winRate: 0 }), '30D', known)[0]
    const fifty = computeArenaScoresV4WithOptions(cohortWith({ winRate: 50 }), '30D', known)[0]
    expect(zero.quality).toBeLessThan(fifty.quality)
    expect(zero.totalScore).toBeLessThan(fifty.totalScore)
  })

  it('counts a 0 observation as present data for confidence', () => {
    const zero = computeArenaScoresV4WithOptions(
      cohortWith({ maxDrawdown: 0, winRate: 0 }),
      '30D',
      known
    )[0]
    const missing = computeArenaScoresV4WithOptions(
      cohortWith({ maxDrawdown: null, winRate: null }),
      '30D',
      known
    )[0]
    expect(zero.confidence).toBeGreaterThan(missing.confidence)
  })
})

describe('computeArenaScoresV4WithOptions: legacy options reproduce the signed contracts', () => {
  const cohort = cohortWith({ maxDrawdown: 0, winRate: 0 })

  it('zeroRiskMetricsAreKnown=false is computeArenaScoresV4 (0 read as missing)', () => {
    const legacy = computeArenaScoresV4WithOptions(cohort, '30D', {
      zeroRiskMetricsAreKnown: false,
    })
    expect(legacy).toEqual(computeArenaScoresV4(cohort, '30D'))
    expect(legacy[0].factors.drawdown).toBeNull()
    expect(legacy[0].factors.consistency).toBeNull()
  })

  it('zeroRiskMetricsAreKnown=true is computeArenaScoresV5', () => {
    expect(
      computeArenaScoresV4WithOptions(cohort, '30D', { zeroRiskMetricsAreKnown: true })
    ).toEqual(computeArenaScoresV5(cohort, '30D'))
  })
})
