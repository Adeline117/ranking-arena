/**
 * Arena Score — supplemental edge-case tests
 *
 * Focuses on gaps NOT covered by arena-score.test.ts:
 * - calculateArenaScoreV3Legacy edge cases (negative ROI, null fields, confidence)
 * - calculateReturnScore with BigInt overflow-prevention
 * - calculatePnlScore with extreme negative base ratio
 * - Period coefficient differentiation (exact values, not just "different")
 * - calculateOverallScore clip to 0 when momentum drives total negative
 * - Idempotency / determinism checks
 */

jest.mock('@/lib/features', () => ({
  isFeatureEnabledForUser: jest.fn().mockReturnValue(false),
}))

import {
  calculateArenaScore,
  calculateArenaScoreV3Legacy,
  calculateReturnScore,
  calculatePnlScore,
  calculateOverallScore,
  calculateMomentumBonus,
  getScoreConfidence,
  wilsonConfidenceMultiplier,
  ARENA_CONFIG,
  type TraderScoreInput,
  type TraderScoreInputV3,
  type Period,
} from '../arena-score'

// ============================================
// calculateArenaScoreV3Legacy edge cases
// ============================================

describe('calculateArenaScoreV3Legacy', () => {
  const baseInput: TraderScoreInputV3 = {
    roi: 50,
    pnl: 5000,
    maxDrawdown: -10,
    winRate: 60,
    alpha: 5,
    sortinoRatio: 1.5,
    calmarRatio: 1.0,
    maxConsecutiveWins: 5,
    maxConsecutiveLosses: 3,
  }

  it('produces a positive score with full input', () => {
    const result = calculateArenaScoreV3Legacy(baseInput, '30D')
    expect(result.totalScore).toBeGreaterThan(0)
    expect(result.totalScore).toBeLessThanOrEqual(100)
  })

  it('returns all sub-score fields', () => {
    const result = calculateArenaScoreV3Legacy(baseInput, '30D')
    expect(result).toHaveProperty('totalScore')
    expect(result).toHaveProperty('returnScore')
    expect(result).toHaveProperty('pnlScore')
    expect(result).toHaveProperty('drawdownScore')
    expect(result).toHaveProperty('stabilityScore')
    expect(result).toHaveProperty('alphaScore')
    expect(result).toHaveProperty('riskAdjustedScore')
    expect(result).toHaveProperty('consistencyScore')
    expect(result).toHaveProperty('scoreConfidence')
  })

  it('negative ROI produces 0 returnScore', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, roi: -50 }, '30D')
    expect(result.returnScore).toBe(0)
  })

  it('zero PnL produces 0 pnlScore', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, pnl: 0 }, '30D')
    expect(result.pnlScore).toBe(0)
  })

  it('null PnL produces 0 pnlScore', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, pnl: null }, '30D')
    expect(result.pnlScore).toBe(0)
  })

  it('null alpha produces 0 alphaScore', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, alpha: null }, '30D')
    expect(result.alphaScore).toBe(0)
  })

  it('negative alpha produces 0 alphaScore', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, alpha: -5 }, '30D')
    expect(result.alphaScore).toBe(0)
  })

  it('alpha > 10 is capped at 5 points', () => {
    const result = calculateArenaScoreV3Legacy({ ...baseInput, alpha: 100 }, '30D')
    expect(result.alphaScore).toBe(5)
  })

  it('null sortino and calmar produce 0 riskAdjustedScore', () => {
    const result = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: null, calmarRatio: null },
      '30D'
    )
    expect(result.riskAdjustedScore).toBe(0)
  })

  it('negative sortino produces 0 contribution to riskAdjustedScore', () => {
    const result = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: -1, calmarRatio: null },
      '30D'
    )
    expect(result.riskAdjustedScore).toBe(0)
  })

  it('sortino ratio is capped at 2 (7 points max)', () => {
    const atCap = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: 2, calmarRatio: null },
      '30D'
    )
    const overCap = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: 100, calmarRatio: null },
      '30D'
    )
    expect(atCap.riskAdjustedScore).toBeCloseTo(overCap.riskAdjustedScore, 5)
  })

  it('calmar ratio is capped at 2 (3 points max)', () => {
    const atCap = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: null, calmarRatio: 2 },
      '30D'
    )
    const overCap = calculateArenaScoreV3Legacy(
      { ...baseInput, sortinoRatio: null, calmarRatio: 100 },
      '30D'
    )
    expect(atCap.riskAdjustedScore).toBeCloseTo(overCap.riskAdjustedScore, 5)
  })

  it('consistencyScore is always 2.5 (neutral default)', () => {
    const result = calculateArenaScoreV3Legacy(baseInput, '30D')
    expect(result.consistencyScore).toBe(2.5)
  })

  it('applies Wilson confidence multiplier (full data > minimal data)', () => {
    const full = calculateArenaScoreV3Legacy(baseInput, '30D')
    const minimal = calculateArenaScoreV3Legacy(
      {
        ...baseInput,
        maxDrawdown: null,
        winRate: null,
        sortinoRatio: null,
        calmarRatio: null,
        alpha: null,
      },
      '30D'
    )
    // Same ROI + PnL but fewer metrics → lower Wilson multiplier → lower total
    expect(full.totalScore).toBeGreaterThan(minimal.totalScore)
  })

  it('scoreConfidence reflects getScoreConfidence output', () => {
    const fullResult = calculateArenaScoreV3Legacy(baseInput, '30D')
    expect(fullResult.scoreConfidence).toBe('full')

    const partialResult = calculateArenaScoreV3Legacy({ ...baseInput, winRate: null }, '30D')
    expect(partialResult.scoreConfidence).toBe('partial')

    const minimalResult = calculateArenaScoreV3Legacy(
      { ...baseInput, winRate: null, maxDrawdown: null },
      '30D'
    )
    expect(minimalResult.scoreConfidence).toBe('minimal')
  })

  it('totalScore never exceeds 100', () => {
    const extreme = calculateArenaScoreV3Legacy(
      {
        roi: 10000,
        pnl: 10000000,
        maxDrawdown: -1,
        winRate: 99,
        alpha: 100,
        sortinoRatio: 100,
        calmarRatio: 100,
        maxConsecutiveWins: 100,
        maxConsecutiveLosses: 0,
      },
      '30D'
    )
    expect(extreme.totalScore).toBeLessThanOrEqual(100)
    expect(extreme.totalScore).toBeGreaterThan(0)
  })

  it('works across all periods', () => {
    for (const period of ['7D', '30D', '90D'] as Period[]) {
      const result = calculateArenaScoreV3Legacy(baseInput, period)
      expect(result.totalScore).toBeGreaterThan(0)
      expect(result.totalScore).toBeLessThanOrEqual(100)
      expect(Number.isFinite(result.totalScore)).toBe(true)
    }
  })

  it('zero ROI + zero PnL + all nulls produces minimal but non-negative score', () => {
    const result = calculateArenaScoreV3Legacy(
      {
        roi: 0,
        pnl: 0,
        maxDrawdown: null,
        winRate: null,
        alpha: null,
        sortinoRatio: null,
        calmarRatio: null,
        maxConsecutiveWins: null,
        maxConsecutiveLosses: null,
      },
      '30D'
    )
    // consistencyScore = 2.5 * low Wilson multiplier → small positive total
    expect(result.totalScore).toBeGreaterThanOrEqual(0)
    expect(result.returnScore).toBe(0)
    expect(result.pnlScore).toBe(0)
  })
})

// ============================================
// Determinism / idempotency
// ============================================

describe('Arena Score — determinism', () => {
  it('calculateArenaScore is deterministic for same input', () => {
    const input: TraderScoreInput = {
      roi: 123.456,
      pnl: 78901.23,
      maxDrawdown: -12.5,
      winRate: 62.3,
    }
    const results = Array.from({ length: 10 }, () => calculateArenaScore(input, '30D'))
    for (let i = 1; i < results.length; i++) {
      expect(results[i].totalScore).toBe(results[0].totalScore)
      expect(results[i].returnScore).toBe(results[0].returnScore)
      expect(results[i].pnlScore).toBe(results[0].pnlScore)
    }
  })

  it('calculateOverallScore is deterministic', () => {
    const input = { score7d: 45.67, score30d: 56.78, score90d: 67.89 }
    const results = Array.from({ length: 10 }, () => calculateOverallScore(input))
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0])
    }
  })
})

// ============================================
// Exact period coefficient values
// ============================================

describe('Arena Score — period coefficient exactness', () => {
  it('7D params match config exactly', () => {
    const p = ARENA_CONFIG.PARAMS['7D']
    expect(p.tanhCoeff).toBe(0.08)
    expect(p.roiExponent).toBe(1.8)
  })

  it('30D params match config exactly', () => {
    const p = ARENA_CONFIG.PARAMS['30D']
    expect(p.tanhCoeff).toBe(0.15)
    expect(p.roiExponent).toBe(1.6)
  })

  it('90D params match config exactly', () => {
    const p = ARENA_CONFIG.PARAMS['90D']
    expect(p.tanhCoeff).toBe(0.18)
    expect(p.roiExponent).toBe(1.6)
  })

  it('PNL_PARAMS 7D has smallest base', () => {
    expect(ARENA_CONFIG.PNL_PARAMS['7D'].base).toBeLessThan(ARENA_CONFIG.PNL_PARAMS['30D'].base)
    expect(ARENA_CONFIG.PNL_PARAMS['30D'].base).toBeLessThan(ARENA_CONFIG.PNL_PARAMS['90D'].base)
  })

  it('PNL_PARAMS 7D has largest coeff', () => {
    expect(ARENA_CONFIG.PNL_PARAMS['7D'].coeff).toBeGreaterThan(
      ARENA_CONFIG.PNL_PARAMS['30D'].coeff
    )
    expect(ARENA_CONFIG.PNL_PARAMS['30D'].coeff).toBeGreaterThan(
      ARENA_CONFIG.PNL_PARAMS['90D'].coeff
    )
  })
})

// ============================================
// calculateOverallScore — negative momentum driving total below 0
// ============================================

describe('calculateOverallScore — clip floor', () => {
  it('clips to 0 when momentum drives total negative', () => {
    // Very low scores + negative momentum
    const score = calculateOverallScore({
      score7d: 0.1,
      score30d: 2,
      score90d: 0.1,
    })
    // base = 0.70*0.1 + 0.25*2 + 0.05*0.1 = 0.575
    // momentum: clip(0.1/2 - 1, -0.2, 0.5) * 5 = clip(-0.95, -0.2, 0.5) * 5 = -1
    // total = 0.575 - 1 = -0.425 → clipped to 0
    expect(score).toBe(0)
  })

  it('returns positive when momentum is negative but not enough to zero out', () => {
    const score = calculateOverallScore({
      score7d: 10,
      score30d: 30,
      score90d: 50,
    })
    // base = 0.70*50 + 0.25*30 + 0.05*10 = 43
    // momentum: clip(10/30 - 1, -0.2, 0.5)*5 = clip(-0.667,-0.2,0.5)*5 = -1
    // total = 43 - 1 = 42
    expect(score).toBeCloseTo(42, 1)
  })
})

// ============================================
// getScoreConfidence — WR=0 treated as missing
// ============================================

describe('getScoreConfidence — WR=0 edge case', () => {
  it('WR=0 is treated as missing data', () => {
    expect(getScoreConfidence(-10, 0)).toBe('partial')
  })

  it('DD=0 and WR=0 both treated as missing', () => {
    expect(getScoreConfidence(0, 0)).toBe('minimal')
  })
})

// ============================================
// calculateReturnScore — edge near tanh inflection
// ============================================

describe('calculateReturnScore — around inflection point', () => {
  it('ROI=1% across periods all positive and monotonically increasing vs higher ROI', () => {
    for (const period of ['7D', '30D', '90D'] as const) {
      const low = calculateReturnScore(1, period)
      const mid = calculateReturnScore(10, period)
      const high = calculateReturnScore(100, period)
      expect(low).toBeGreaterThan(0)
      expect(mid).toBeGreaterThan(low)
      expect(high).toBeGreaterThan(mid)
    }
  })

  it('ROI just below -100% does not crash (safeLog1p protects)', () => {
    // ROI = -100% → decimal = -1 → ln(0) → safeLog1p returns 0 → score 0
    expect(calculateReturnScore(-100, '30D')).toBe(0)
    // ROI = -150% → decimal = -1.5 → ln(-0.5) → safeLog1p returns 0
    expect(calculateReturnScore(-150, '30D')).toBe(0)
  })
})

// ============================================
// calculatePnlScore — extreme edge near log singularity
// ============================================

describe('calculatePnlScore — near log singularity', () => {
  it('PnL very close to negative base does not crash', () => {
    // PnL = -base → logArg = 1 + (-base)/base = 0 → log(0) guarded
    // For 30D, base=600
    const score = calculatePnlScore(-600, '30D')
    expect(score).toBe(0)
  })

  it('PnL more negative than base returns 0', () => {
    // logArg = 1 + (-1000)/600 = -0.667 → ≤ 0 → return 0
    const score = calculatePnlScore(-1000, '30D')
    expect(score).toBe(0)
  })
})

// ============================================
// calculateMomentumBonus — exact boundary values
// ============================================

describe('calculateMomentumBonus — exact boundary arithmetic', () => {
  it('ratio exactly at +0.5 gives max bonus 2.5', () => {
    // 7d/30d - 1 = 0.5 → 7d = 30d * 1.5
    const bonus = calculateMomentumBonus(75, 50)
    expect(bonus).toBe(2.5)
  })

  it('ratio exactly at -0.2 gives max penalty -1', () => {
    // 7d/30d - 1 = -0.2 → 7d = 30d * 0.8
    const bonus = calculateMomentumBonus(80, 100)
    expect(bonus).toBeCloseTo(-1, 10)
  })

  it('both null returns 0', () => {
    expect(calculateMomentumBonus(null, null)).toBe(0)
  })
})
