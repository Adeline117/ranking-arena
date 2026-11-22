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
  const known = { zeroRiskMetricsAreKnown: true, missingRiskPolicy: 'renormalize' } as const

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
      missingRiskPolicy: 'renormalize',
    })
    expect(legacy).toEqual(computeArenaScoresV4(cohort, '30D'))
    expect(legacy[0].factors.drawdown).toBeNull()
    expect(legacy[0].factors.consistency).toBeNull()
  })

  it('zeroRiskMetricsAreKnown=true is computeArenaScoresV5', () => {
    expect(
      computeArenaScoresV4WithOptions(cohort, '30D', {
        zeroRiskMetricsAreKnown: true,
        missingRiskPolicy: 'renormalize',
      })
    ).toEqual(computeArenaScoresV5(cohort, '30D'))
  })
})

describe("missingRiskPolicy 'zero': a missing risk metric never raises the score", () => {
  const zero = { zeroRiskMetricsAreKnown: true, missingRiskPolicy: 'zero' } as const
  const renormalize = { zeroRiskMetricsAreKnown: true, missingRiskPolicy: 'renormalize' } as const

  /** Deterministic PRNG (mulberry32) so a failure is reproducible. */
  function prng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function randomTrader(random: () => number): TraderScoreInputV4 {
    const pick = random()
    return {
      roi: Math.round((random() * 400 - 100) * 100) / 100,
      pnl: Math.round((random() * 2_000_000 - 200_000) * 100) / 100,
      // Values include exact 0 so "0 is an observation" is exercised too.
      maxDrawdown: random() < 0.2 ? null : Math.floor(random() * 99),
      winRate: random() < 0.2 ? null : Math.floor(random() * 101),
      sharpeRatio: random() < 0.6 ? null : Math.round((random() * 6 - 2) * 100) / 100,
      profitFactor: null,
      tradesCount: pick < 0.4 ? null : pick < 0.5 ? 0 : Math.floor(random() * 500) + 1,
      source: 'bybit',
    }
  }

  // The cohort holds the complete twin at index 0 and a twin with one or both
  // risk metrics removed at index 1. Same cohort, so percentiles are shared.
  it.each([
    ['drawdown removed', { maxDrawdown: null }],
    ['win rate removed', { winRate: null }],
    ['both removed', { maxDrawdown: null, winRate: null }],
  ] as const)('%s: twin without the metric scores <= twin with it', (_label, removed) => {
    const random = prng(20261122)
    for (let round = 0; round < 300; round += 1) {
      const size = 3 + Math.floor(random() * 40)
      const others = Array.from({ length: size }, () => randomTrader(random))
      const complete: TraderScoreInputV4 = {
        ...randomTrader(random),
        maxDrawdown: Math.floor(random() * 99),
        winRate: Math.floor(random() * 101),
      }
      // Trade count: unknown, true unknown-zero, and known all occur.
      const missing: TraderScoreInputV4 = { ...complete, ...removed }
      const [withMetric, withoutMetric] = computeArenaScoresV4WithOptions(
        [complete, missing, ...others],
        '30D',
        zero
      )
      expect(withoutMetric.quality).toBeLessThanOrEqual(withMetric.quality)
      expect(withoutMetric.confidence).toBeLessThanOrEqual(withMetric.confidence)
      expect(withoutMetric.totalScore).toBeLessThanOrEqual(withMetric.totalScore)
    }
  })

  it.each([
    ['trade count unknown', null],
    ['trade count known', 100],
  ] as const)('holds with %s for a strong earner with mediocre risk', (_label, tradesCount) => {
    // Design §3.2: high ROI/PnL, risk percentiles below the earnings factors.
    const filler = Array.from({ length: 40 }, (_, i) => ({
      ...base,
      roi: i,
      pnl: 1_500 + i * 500,
      maxDrawdown: 10 + i,
      winRate: 30 + i,
      tradesCount,
    }))
    const complete = {
      ...base,
      roi: 500,
      pnl: 1_000_000,
      maxDrawdown: 45,
      winRate: 35,
      tradesCount,
    }
    const missing = { ...complete, maxDrawdown: null, winRate: null }
    const cohort = [complete, missing, ...filler]

    const [withMetric, withoutMetric] = computeArenaScoresV4WithOptions(cohort, '30D', zero)
    expect(withoutMetric.totalScore).toBeLessThan(withMetric.totalScore)

    // The rule being replaced does lift the row that reports nothing.
    const [legacyWith, legacyWithout] = computeArenaScoresV4WithOptions(cohort, '30D', renormalize)
    expect(legacyWithout.quality).toBeGreaterThan(legacyWith.quality)
  })

  it('caps quality at 0.5/0.8 for a row with neither drawdown nor win rate (no Sharpe)', () => {
    const cohort = cohortWith({ roi: 9_000, pnl: 50_000_000, maxDrawdown: null, winRate: null })
    const [subject] = computeArenaScoresV4WithOptions(cohort, '30D', zero)
    // roi percentile 1, PnL factor 1 => (0.3 + 0.2) / 0.8
    expect(subject.quality).toBe(0.63)
    expect(subject.factors).toMatchObject({ roi: 1, pnl: 1, drawdown: null, consistency: null })
  })

  it('still reports the missing dimensions as null factors', () => {
    const [subject] = computeArenaScoresV4WithOptions(
      cohortWith({ maxDrawdown: null, winRate: null }),
      '30D',
      zero
    )
    expect(subject.factors.drawdown).toBeNull()
    expect(subject.factors.consistency).toBeNull()
  })

  it('does not change a cohort where every row has both metrics', () => {
    const cohort = cohortWith({})
    expect(computeArenaScoresV4WithOptions(cohort, '30D', zero)).toEqual(
      computeArenaScoresV4WithOptions(cohort, '30D', renormalize)
    )
  })

  it('leaves Sharpe on the renormalizing rule', () => {
    const cohort = cohortWith({}).map((row, i) => ({ ...row, sharpeRatio: i === 0 ? null : i }))
    const [subject] = computeArenaScoresV4WithOptions(cohort, '30D', zero)
    expect(subject.factors.sharpe).toBeNull()
    // With drawdown + consistency present the denominator is 0.8, not 1.0.
    const f = subject.factors
    const expected = (0.3 * f.pnl + 0.2 * f.roi + 0.2 * f.drawdown! + 0.1 * f.consistency!) / 0.8
    expect(subject.quality).toBeCloseTo(expected, 1)
  })
})
