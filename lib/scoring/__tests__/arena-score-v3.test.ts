/**
 * Arena Score V3 — Percentile-Based Three-Dimension Scoring Tests
 *
 * Covers:
 *   - percentileRank: edge cases, ties, single peer
 *   - detectCompleteness: all 4 levels
 *   - calculateArenaScoreV3: full/partial/minimal/insufficient data
 *   - calculateMultiWindowScore: multi-window weighting
 *   - buildPeerContext: DB array → sorted context
 *   - Monotonicity & bounds invariants
 */

import {
  percentileRank,
  detectCompleteness,
  calculateArenaScoreV3,
  calculateMultiWindowScore,
  buildPeerContext,
  type ArenaScoreV3Input,
  type PercentileContext,
} from '../arena-score-v3'

// ============================================
// Helper: create full peer context from arrays
// ============================================

function makePeers(overrides: Partial<PercentileContext> = {}): PercentileContext {
  const base = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  return {
    roi_values: overrides.roi_values ?? base,
    alpha_values: overrides.alpha_values ?? base.map(v => v / 10),
    drawdown_values: overrides.drawdown_values ?? [5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
    sortino_values: overrides.sortino_values ?? [0.5, 1.0, 1.5, 2.0, 2.5],
    calmar_values: overrides.calmar_values ?? [0.3, 0.6, 0.9, 1.2, 1.5],
    winrate_values: overrides.winrate_values ?? [40, 45, 50, 55, 60, 65, 70],
    plr_values: overrides.plr_values ?? [0.8, 1.0, 1.2, 1.5, 2.0, 2.5],
  }
}

function fullInput(overrides: Partial<ArenaScoreV3Input> = {}): ArenaScoreV3Input {
  return {
    roi: 50,
    alpha: 5,
    max_drawdown: -15,
    sortino_ratio: 1.5,
    calmar_ratio: 1.0,
    win_rate: 60,
    profit_factor: 1.5,
    ...overrides,
  }
}

// ============================================
// percentileRank
// ============================================

describe('percentileRank', () => {
  test('empty array returns 50 (neutral)', () => {
    expect(percentileRank([], 42)).toBe(50)
  })

  test('single peer: value >= peer returns 75', () => {
    expect(percentileRank([30], 30)).toBe(75)
    expect(percentileRank([30], 50)).toBe(75)
  })

  test('single peer: value < peer returns 25', () => {
    expect(percentileRank([30], 10)).toBe(25)
  })

  test('bottom of sorted array has low percentile', () => {
    const sorted = [10, 20, 30, 40, 50]
    const pctl = percentileRank(sorted, 10)
    expect(pctl).toBeLessThan(20)
  })

  test('top of sorted array has high percentile', () => {
    const sorted = [10, 20, 30, 40, 50]
    const pctl = percentileRank(sorted, 50)
    expect(pctl).toBeGreaterThan(80)
  })

  test('median value gives ~50th percentile', () => {
    const sorted = [10, 20, 30, 40, 50]
    const pctl = percentileRank(sorted, 30)
    expect(pctl).toBeCloseTo(50, 0)
  })

  test('value below all peers returns 0', () => {
    const sorted = [10, 20, 30]
    const pctl = percentileRank(sorted, 5)
    expect(pctl).toBe(0)
  })

  test('value above all peers returns 100', () => {
    const sorted = [10, 20, 30]
    const pctl = percentileRank(sorted, 100)
    expect(pctl).toBe(100)
  })

  test('handles ties correctly (average rank)', () => {
    const sorted = [10, 20, 20, 20, 30]
    const pctl = percentileRank(sorted, 20)
    // below=1, equal=3, pctl = (1 + 1.5) / 5 * 100 = 50
    expect(pctl).toBe(50)
  })

  test('monotonicity: higher value => higher or equal percentile', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    let prev = -Infinity
    for (let v = 0; v <= 110; v += 5) {
      const p = percentileRank(sorted, v)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
  })
})

// ============================================
// detectCompleteness
// ============================================

describe('detectCompleteness', () => {
  test('insufficient: no ROI', () => {
    expect(detectCompleteness({ roi: null, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null }))
      .toBe('insufficient')
  })

  test('minimal: only ROI', () => {
    expect(detectCompleteness({ roi: 50, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null }))
      .toBe('minimal')
  })

  test('partial: ROI + drawdown (no sortino/calmar)', () => {
    expect(detectCompleteness({ roi: 50, alpha: null, max_drawdown: -10, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null }))
      .toBe('partial')
  })

  test('partial: ROI + win_rate (no sortino/calmar)', () => {
    expect(detectCompleteness({ roi: 50, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: 60, profit_factor: null }))
      .toBe('partial')
  })

  test('full: all metrics present', () => {
    expect(detectCompleteness(fullInput())).toBe('full')
  })
})

// ============================================
// calculateArenaScoreV3
// ============================================

describe('calculateArenaScoreV3', () => {
  const peers = makePeers()

  test('insufficient data returns zero score', () => {
    const result = calculateArenaScoreV3(
      { roi: null, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null },
      peers
    )
    expect(result.total).toBe(0)
    expect(result.completeness).toBe('insufficient')
    expect(result.profitability).toBe(0)
    expect(result.risk_control).toBe(0)
    expect(result.execution).toBe(0)
  })

  test('full data produces positive score in [0, 100]', () => {
    const result = calculateArenaScoreV3(fullInput(), peers)
    expect(result.total).toBeGreaterThan(0)
    expect(result.total).toBeLessThanOrEqual(100)
    expect(result.completeness).toBe('full')
    expect(result.penalty).toBe(0)
  })

  test('partial data incurs 5-point penalty', () => {
    const result = calculateArenaScoreV3(
      fullInput({ sortino_ratio: null, calmar_ratio: null }),
      peers
    )
    expect(result.penalty).toBe(5)
    expect(result.completeness).toBe('partial')
  })

  test('minimal data incurs 15-point penalty and cap at 60', () => {
    const result = calculateArenaScoreV3(
      { roi: 80, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null },
      peers
    )
    expect(result.penalty).toBe(15)
    expect(result.completeness).toBe('minimal')
    expect(result.total).toBeLessThanOrEqual(60)
  })

  test('higher ROI produces higher profitability score (full data)', () => {
    const low = calculateArenaScoreV3(fullInput({ roi: 20 }), peers)
    const high = calculateArenaScoreV3(fullInput({ roi: 80 }), peers)
    expect(high.profitability).toBeGreaterThan(low.profitability)
  })

  test('lower drawdown produces higher risk_control score', () => {
    const badDd = calculateArenaScoreV3(fullInput({ max_drawdown: -45 }), peers)
    const goodDd = calculateArenaScoreV3(fullInput({ max_drawdown: -5 }), peers)
    expect(goodDd.risk_control).toBeGreaterThan(badDd.risk_control)
  })

  test('higher win rate produces higher execution score', () => {
    const low = calculateArenaScoreV3(fullInput({ win_rate: 42 }), peers)
    const high = calculateArenaScoreV3(fullInput({ win_rate: 68 }), peers)
    expect(high.execution).toBeGreaterThan(low.execution)
  })

  test('dimension bounds respected: profitability <= 35, risk <= 40, execution <= 25', () => {
    const result = calculateArenaScoreV3(fullInput({ roi: 999 }), peers)
    expect(result.profitability).toBeLessThanOrEqual(35)
    expect(result.risk_control).toBeLessThanOrEqual(40)
    expect(result.execution).toBeLessThanOrEqual(25)
  })

  test('all components are non-negative', () => {
    const result = calculateArenaScoreV3(fullInput(), peers)
    const { components } = result
    expect(components.roi_score).toBeGreaterThanOrEqual(0)
    expect(components.alpha_score).toBeGreaterThanOrEqual(0)
    expect(components.drawdown_score).toBeGreaterThanOrEqual(0)
    expect(components.sortino_score).toBeGreaterThanOrEqual(0)
    expect(components.calmar_score).toBeGreaterThanOrEqual(0)
    expect(components.winrate_score).toBeGreaterThanOrEqual(0)
    expect(components.plr_score).toBeGreaterThanOrEqual(0)
  })
})

// ============================================
// calculateMultiWindowScore
// ============================================

describe('calculateMultiWindowScore', () => {
  const peers = makePeers()
  const input = fullInput()

  test('single window produces valid result', () => {
    const result = calculateMultiWindowScore({
      '30D': { input, peers },
    })
    expect(result.total).toBeGreaterThan(0)
    expect(result.total).toBeLessThanOrEqual(100)
    expect(result.byWindow['30D']).toBeDefined()
  })

  test('all three windows produces valid result', () => {
    const result = calculateMultiWindowScore({
      '7D': { input, peers },
      '30D': { input, peers },
      '90D': { input, peers },
    })
    expect(result.total).toBeGreaterThan(0)
    expect(result.total).toBeLessThanOrEqual(100)
    expect(Object.keys(result.byWindow).length).toBe(3)
  })

  test('empty windows produces zero', () => {
    const result = calculateMultiWindowScore({})
    expect(result.total).toBe(0)
  })

  test('insufficient data window is skipped', () => {
    const result = calculateMultiWindowScore({
      '30D': {
        input: { roi: null, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null },
        peers,
      },
    })
    expect(result.total).toBe(0)
    expect(result.completeness).toBe('insufficient')
  })

  test('worst completeness propagates', () => {
    const result = calculateMultiWindowScore({
      '7D': { input: fullInput(), peers },
      '30D': { input: fullInput({ sortino_ratio: null, calmar_ratio: null }), peers },
      '90D': { input: { roi: 50, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null }, peers },
    })
    expect(result.completeness).toBe('minimal')
  })
})

// ============================================
// buildPeerContext
// ============================================

describe('buildPeerContext', () => {
  test('builds sorted arrays from peer data', () => {
    const peers = [
      { roi: 50, alpha: 5, max_drawdown: -20, sortino_ratio: 1.5, calmar_ratio: 1.0, win_rate: 60, profit_factor: 1.5 },
      { roi: 30, alpha: 3, max_drawdown: -10, sortino_ratio: 2.0, calmar_ratio: 0.5, win_rate: 55, profit_factor: 1.2 },
      { roi: 70, alpha: null, max_drawdown: -30, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null },
    ]
    const ctx = buildPeerContext(peers)
    expect(ctx.roi_values).toEqual([30, 50, 70])
    expect(ctx.drawdown_values).toEqual([10, 20, 30]) // absolute values, sorted
    expect(ctx.alpha_values).toEqual([3, 5]) // null excluded
    expect(ctx.winrate_values).toEqual([55, 60]) // null excluded
  })

  test('empty peers produce empty arrays', () => {
    const ctx = buildPeerContext([])
    expect(ctx.roi_values).toEqual([])
    expect(ctx.alpha_values).toEqual([])
    expect(ctx.drawdown_values).toEqual([])
  })

  test('normalizes win_rate <= 1 to percentage', () => {
    const peers = [
      { roi: 50, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: 0.65, profit_factor: null },
      { roi: 30, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: 55, profit_factor: null },
    ]
    const ctx = buildPeerContext(peers)
    expect(ctx.winrate_values).toEqual([55, 65]) // 0.65 → 65, sorted
  })
})

// ============================================
// Invariant: output bounds hold for random inputs
// ============================================

describe('Score bounds invariant', () => {
  test('score is always in [0, 100] for diverse inputs', () => {
    const peers = makePeers()
    const testInputs: ArenaScoreV3Input[] = [
      fullInput({ roi: 0 }),
      fullInput({ roi: -50 }),
      fullInput({ roi: 9999 }),
      fullInput({ roi: 1, max_drawdown: -99, win_rate: 1 }),
      { roi: 50, alpha: null, max_drawdown: null, sortino_ratio: null, calmar_ratio: null, win_rate: null, profit_factor: null },
    ]
    for (const input of testInputs) {
      const result = calculateArenaScoreV3(input, peers)
      expect(result.total).toBeGreaterThanOrEqual(0)
      expect(result.total).toBeLessThanOrEqual(100)
      expect(Number.isFinite(result.total)).toBe(true)
    }
  })
})
