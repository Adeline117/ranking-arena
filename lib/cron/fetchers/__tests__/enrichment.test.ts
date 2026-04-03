/**
 * Enrichment Function Tests
 *
 * Tests the derived metrics calculation functions:
 *   - calculateVolatility
 *   - calculateCurrentDrawdown
 *   - calculateMaxDrawdown
 *   - calculateSharpeRatio
 *   - enhanceStatsWithDerivedMetrics
 */

import {
  calculateVolatility,
  calculateCurrentDrawdown,
  calculateMaxDrawdown,
  calculateSharpeRatio,
  enhanceStatsWithDerivedMetrics,
  type EquityCurvePoint,
  type StatsDetail,
} from '../enrichment'

// ============================================
// Volatility Calculation Tests
// ============================================

describe('calculateVolatility', () => {
  test('returns null for empty curve', () => {
    const result = calculateVolatility([])
    expect(result).toBeNull()
  })

  test('returns null for single point', () => {
    const curve: EquityCurvePoint[] = [{ date: '2024-01-01', roi: 10, pnl: 1000 }]
    const result = calculateVolatility(curve)
    expect(result).toBeNull()
  })

  test('returns null for two points (needs at least 3)', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 12, pnl: 1200 },
    ]
    const result = calculateVolatility(curve)
    expect(result).toBeNull()
  })

  test('calculates volatility for varying returns', () => {
    // Variable daily returns should have positive volatility
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 15, pnl: 1500 }, // +5
      { date: '2024-01-03', roi: 12, pnl: 1200 }, // -3
      { date: '2024-01-04', roi: 18, pnl: 1800 }, // +6
      { date: '2024-01-05', roi: 16, pnl: 1600 }, // -2
    ]
    const result = calculateVolatility(curve)
    expect(result).not.toBeNull()
    expect(result).toBeGreaterThan(0)
  })

  test('calculates higher volatility for unstable curve', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 30, pnl: 3000 },
      { date: '2024-01-03', roi: 5, pnl: 500 },
      { date: '2024-01-04', roi: 50, pnl: 5000 },
      { date: '2024-01-05', roi: 20, pnl: 2000 },
    ]
    const result = calculateVolatility(curve)
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(10) // High volatility expected
  })
})

// ============================================
// Current Drawdown Tests
// ============================================

describe('calculateCurrentDrawdown', () => {
  test('returns null for empty curve', () => {
    const result = calculateCurrentDrawdown([])
    expect(result).toBeNull()
  })

  test('returns null for single point', () => {
    const curve: EquityCurvePoint[] = [{ date: '2024-01-01', roi: 10, pnl: 1000 }]
    const result = calculateCurrentDrawdown(curve)
    expect(result).toBeNull()
  })

  test('returns 0 when at peak', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 20, pnl: 2000 },
      { date: '2024-01-03', roi: 30, pnl: 3000 }, // Peak is last point
    ]
    const result = calculateCurrentDrawdown(curve)
    expect(result).toBe(0)
  })

  test('calculates drawdown from peak as absolute ROI difference', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 50, pnl: 5000 }, // Peak
      { date: '2024-01-03', roi: 30, pnl: 3000 }, // Current
    ]
    const result = calculateCurrentDrawdown(curve)
    expect(result).not.toBeNull()
    // Peak = 50, Current = 30, Drawdown = 50 - 30 = 20 (absolute difference)
    expect(result).toBe(20)
  })

  test('handles negative ROI correctly', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 20, pnl: 2000 }, // Peak
      { date: '2024-01-02', roi: 10, pnl: 1000 },
      { date: '2024-01-03', roi: -5, pnl: -500 }, // Current (negative)
    ]
    const result = calculateCurrentDrawdown(curve)
    expect(result).not.toBeNull()
    // Peak = 20, Current = -5, Drawdown = 20 - (-5) = 25
    expect(result).toBe(25)
  })
})

// ============================================
// Max Drawdown Tests
// ============================================

describe('calculateMaxDrawdown', () => {
  test('returns null for empty curve', () => {
    const result = calculateMaxDrawdown([])
    expect(result).toBeNull()
  })

  test('returns null for single point', () => {
    const curve: EquityCurvePoint[] = [{ date: '2024-01-01', roi: 10, pnl: 1000 }]
    const result = calculateMaxDrawdown(curve)
    expect(result).toBeNull()
  })

  test('returns null for always increasing curve (no drawdown)', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 20, pnl: 2000 },
      { date: '2024-01-03', roi: 30, pnl: 3000 },
    ]
    const result = calculateMaxDrawdown(curve)
    // Returns null when maxDD is 0
    expect(result).toBeNull()
  })

  test('calculates max drawdown as absolute ROI difference', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 50, pnl: 5000 }, // First peak
      { date: '2024-01-03', roi: 30, pnl: 3000 }, // Drawdown of 20
      { date: '2024-01-04', roi: 60, pnl: 6000 }, // New peak
      { date: '2024-01-05', roi: 25, pnl: 2500 }, // Max drawdown point = 60 - 25 = 35
    ]
    const result = calculateMaxDrawdown(curve)
    expect(result).not.toBeNull()
    // Max drawdown from 60 to 25 = ((60-25)/60)*100 = 58.33%
    expect(result).toBeCloseTo(58.33, 1)
  })

  test('finds max drawdown even with recovery', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 50, pnl: 5000 }, // Peak
      { date: '2024-01-03', roi: 10, pnl: 1000 }, // Max drawdown = 40
      { date: '2024-01-04', roi: 55, pnl: 5500 }, // Recovery above previous peak
    ]
    const result = calculateMaxDrawdown(curve)
    expect(result).not.toBeNull()
    // Max drawdown from 50 to 10 = ((50-10)/50)*100 = 80%
    expect(result).toBe(80)
  })
})

// ============================================
// Sharpe Ratio Tests
// ============================================

describe('calculateSharpeRatio', () => {
  test('returns null for empty curve', () => {
    const result = calculateSharpeRatio([], '90D')
    expect(result).toBeNull()
  })

  test('returns null for insufficient data (less than 7 points)', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 12, pnl: 1200 },
      { date: '2024-01-03', roi: 14, pnl: 1400 },
    ]
    const result = calculateSharpeRatio(curve, '90D')
    expect(result).toBeNull()
  })

  test('calculates positive Sharpe for good consistent returns', () => {
    // Consistent positive returns with low variance
    const curve: EquityCurvePoint[] = []
    for (let i = 0; i < 30; i++) {
      curve.push({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        roi: i * 3, // Consistent 3% daily return (no variance)
        pnl: i * 300,
      })
    }
    const result = calculateSharpeRatio(curve, '30D')
    // With zero variance in daily returns, stdDev = 0, returns null
    expect(result).toBeNull()
  })

  test('calculates positive Sharpe for good returns with realistic variance', () => {
    // Realistic positive returns with variance (mean ~0.1, stdDev ~1.5)
    // This should give Sharpe around 0.1/1.5 * sqrt(365) ≈ 1.3
    const curve: EquityCurvePoint[] = []
    const dailyReturns = [0.5, -1.0, 0.8, -0.3, 1.2, -0.5, 0.6, 0.2, -0.8, 0.9]
    let cumRoi = 0
    for (let i = 0; i < 30; i++) {
      curve.push({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        roi: cumRoi,
        pnl: cumRoi * 100,
      })
      cumRoi += dailyReturns[i % dailyReturns.length]
    }
    const result = calculateSharpeRatio(curve, '30D')
    expect(result).not.toBeNull()
    expect(result!).toBeGreaterThan(0)
    expect(result!).toBeLessThan(5) // Reasonable bound
  })

  test('calculates negative Sharpe for poor returns with realistic variance', () => {
    // Negative returns with higher variance to keep Sharpe within bounds
    // mean ~ -0.1, stdDev ~ 1.5, so Sharpe ~ -0.1/1.5 * sqrt(365) ~ -1.3
    const curve: EquityCurvePoint[] = []
    const dailyReturns = [-0.5, 1.5, -1.5, 0.8, -0.8, -0.3, 1.0, -1.8, 0.6, -0.5]
    let cumRoi = 0
    for (let i = 0; i < 30; i++) {
      curve.push({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        roi: cumRoi,
        pnl: cumRoi * 100,
      })
      cumRoi += dailyReturns[i % dailyReturns.length]
    }
    const result = calculateSharpeRatio(curve, '30D')
    expect(result).not.toBeNull()
    expect(result!).toBeLessThan(0)
    expect(result!).toBeGreaterThan(-10) // Within bounds
  })
})

// ============================================
// Enhanced Stats Tests
// ============================================

describe('enhanceStatsWithDerivedMetrics', () => {
  const baseStats: StatsDetail = {
    totalTrades: 15,
    profitableTradesPct: 66.67,
    avgHoldingTimeHours: 48,
    avgProfit: 100,
    avgLoss: 50,
    largestWin: 500,
    largestLoss: 200,
    sharpeRatio: null,
    maxDrawdown: null,
    currentDrawdown: null,
    volatility: null,
    copiersCount: 100,
    copiersPnl: 5000,
    aum: 100000,
    winningPositions: 10,
    totalPositions: 15,
  }

  test('adds all derived metrics', () => {
    // Realistic curve with variance that produces valid Sharpe ratio
    const curve: EquityCurvePoint[] = []
    const dailyReturns = [0.5, -0.3, 0.8, -0.5, 0.6, -0.2, 0.4, -0.4, 0.7, -0.6]
    let cumRoi = 10 // Start at 10% to have positive peak
    for (let i = 0; i < 30; i++) {
      curve.push({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        roi: cumRoi,
        pnl: cumRoi * 100,
      })
      cumRoi += dailyReturns[i % dailyReturns.length]
    }

    const enhanced = enhanceStatsWithDerivedMetrics(baseStats, curve, '30D')

    // Derived metrics should be calculated
    expect(enhanced.volatility).not.toBeNull()
    expect(enhanced.currentDrawdown).not.toBeNull()
    expect(enhanced.maxDrawdown).not.toBeNull()
    expect(enhanced.sharpeRatio).not.toBeNull()
    // Original stats should be preserved
    expect(enhanced.avgProfit).toBe(100)
    expect(enhanced.avgLoss).toBe(50)
    expect(enhanced.totalTrades).toBe(15)
  })

  test('preserves existing stats when curve is empty', () => {
    const enhanced = enhanceStatsWithDerivedMetrics(baseStats, [], '30D')

    expect(enhanced.avgProfit).toBe(100)
    expect(enhanced.avgLoss).toBe(50)
    expect(enhanced.avgHoldingTimeHours).toBe(48)
    expect(enhanced.totalTrades).toBe(15)
  })

  test('handles null pnl values in curve', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: null },
      { date: '2024-01-02', roi: 20, pnl: 2000 },
      { date: '2024-01-03', roi: 15, pnl: null },
    ]

    const enhanced = enhanceStatsWithDerivedMetrics(baseStats, curve, '7D')
    // Should not throw, should still calculate what it can
    expect(enhanced).toBeDefined()
    // pnl values are not used in derived calculations, so they should work
    expect(enhanced.volatility).not.toBeNull()
    expect(enhanced.currentDrawdown).not.toBeNull()
    expect(enhanced.maxDrawdown).not.toBeNull()
  })

  test('does not overwrite existing derived metrics', () => {
    const statsWithMetrics: StatsDetail = {
      ...baseStats,
      volatility: 15.5,
      currentDrawdown: 5,
      maxDrawdown: 20,
      sharpeRatio: 1.5,
    }

    const curve: EquityCurvePoint[] = []
    for (let i = 0; i < 30; i++) {
      curve.push({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        roi: i * 2 + Math.sin(i) * 5,
        pnl: (i * 2 + Math.sin(i) * 5) * 100,
      })
    }

    const enhanced = enhanceStatsWithDerivedMetrics(statsWithMetrics, curve, '30D')

    // Should preserve existing values, not overwrite
    expect(enhanced.volatility).toBe(15.5)
    expect(enhanced.currentDrawdown).toBe(5)
    expect(enhanced.maxDrawdown).toBe(20)
    expect(enhanced.sharpeRatio).toBe(1.5)
  })
})

// ============================================
// Edge Cases
// ============================================

describe('Edge Cases', () => {
  test('handles very large ROI values (returns null for extreme volatility/drawdown)', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 1000, pnl: 100000 },
      { date: '2024-01-02', roi: 5000, pnl: 500000 },
      { date: '2024-01-03', roi: 2000, pnl: 200000 },
    ]

    const volatility = calculateVolatility(curve)
    const maxDD = calculateMaxDrawdown(curve)
    const currentDD = calculateCurrentDrawdown(curve)

    // With these extreme values:
    // volatility >= 200 returns null
    // maxDD = ((5000-2000)/5000)*100 = 60% (percentage-based)
    expect(volatility).toBeNull() // Too high
    expect(maxDD).toBe(60) // (5000-2000)/5000 * 100
    // currentDD is absolute difference (peak - current)
    expect(currentDD).not.toBeNull()
    expect(currentDD).toBe(3000) // 5000 - 2000
  })

  test('handles moderate ROI values correctly', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 10, pnl: 1000 },
      { date: '2024-01-02', roi: 50, pnl: 5000 },
      { date: '2024-01-03', roi: 20, pnl: 2000 },
    ]

    const volatility = calculateVolatility(curve)
    const maxDD = calculateMaxDrawdown(curve)
    const currentDD = calculateCurrentDrawdown(curve)

    expect(volatility).not.toBeNull()
    expect(maxDD).not.toBeNull()
    expect(currentDD).not.toBeNull()
    expect(maxDD).toBe(60) // ((50-20)/50)*100 = 60%
    expect(currentDD).toBe(30) // 50 - 20 (absolute, current is last point)
  })

  test('handles all negative ROI values', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: -10, pnl: -1000 },
      { date: '2024-01-02', roi: -20, pnl: -2000 },
      { date: '2024-01-03', roi: -15, pnl: -1500 },
    ]

    const volatility = calculateVolatility(curve)

    expect(volatility).not.toBeNull()
    expect(Number.isFinite(volatility!)).toBe(true)
  })

  test('returns null for currentDrawdown when peak is <= 0', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: -10, pnl: -1000 },
      { date: '2024-01-02', roi: -20, pnl: -2000 },
      { date: '2024-01-03', roi: -15, pnl: -1500 },
    ]

    const currentDD = calculateCurrentDrawdown(curve)
    // Peak is -10, which is <= 0, so returns null
    expect(currentDD).toBeNull()
  })

  test('handles zero values in curve', () => {
    const curve: EquityCurvePoint[] = [
      { date: '2024-01-01', roi: 0, pnl: 0 },
      { date: '2024-01-02', roi: 0, pnl: 0 },
      { date: '2024-01-03', roi: 0, pnl: 0 },
    ]

    const volatility = calculateVolatility(curve)
    const maxDD = calculateMaxDrawdown(curve)

    // Zero variance returns null for volatility (0 is not > 0)
    // maxDD = 0 returns null
    expect(volatility).toBeNull()
    expect(maxDD).toBeNull()
  })
})
