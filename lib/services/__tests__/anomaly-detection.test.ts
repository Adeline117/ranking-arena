/**
 * Anomaly Detection Service Tests
 * Comprehensive test suite for anomaly detection algorithms
 */

import {
  calculateMean,
  calculateStdDev,
  calculateZScore,
  calculateQuartiles,
  detectByZScore,
  detectByIQR,
  detectMultiDimensional,
  detectEquityCurveAnomaly,
  classifySeverity,
  AnomalyConfig,
} from '../anomaly-detection'
import type { TraderRankingData } from '../../archive/ranking'

describe('Statistical Utilities', () => {
  describe('calculateMean', () => {
    it('should calculate mean correctly', () => {
      expect(calculateMean([1, 2, 3, 4, 5])).toBe(3)
      expect(calculateMean([10, 20, 30])).toBe(20)
    })

    it('should handle empty array', () => {
      expect(calculateMean([])).toBe(0)
    })

    it('should handle negative numbers', () => {
      expect(calculateMean([-5, -3, -1])).toBe(-3)
    })
  })

  describe('calculateStdDev', () => {
    it('should calculate standard deviation correctly', () => {
      const values = [2, 4, 4, 4, 5, 5, 7, 9]
      const result = calculateStdDev(values)
      expect(result).toBeCloseTo(2.138, 2)
    })

    it('should handle array with < 2 elements', () => {
      expect(calculateStdDev([5])).toBe(0)
      expect(calculateStdDev([])).toBe(0)
    })

    it('should use provided mean', () => {
      const values = [2, 4, 6, 8]
      const mean = calculateMean(values)
      const stdDev1 = calculateStdDev(values)
      const stdDev2 = calculateStdDev(values, mean)
      expect(stdDev1).toBe(stdDev2)
    })
  })

  describe('calculateZScore', () => {
    it('should calculate Z-Score correctly', () => {
      expect(calculateZScore(10, 5, 2)).toBe(2.5)
      expect(calculateZScore(0, 5, 2)).toBe(-2.5)
      expect(calculateZScore(5, 5, 2)).toBe(0)
    })

    it('should handle zero standard deviation', () => {
      expect(calculateZScore(10, 5, 0)).toBe(0)
    })
  })

  describe('calculateQuartiles', () => {
    it('should calculate quartiles correctly', () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const result = calculateQuartiles(values)

      expect(result.q1).toBe(3)
      expect(result.median).toBe(6)
      expect(result.q3).toBe(8)
      expect(result.iqr).toBe(5)
    })

    it('should handle empty array', () => {
      const result = calculateQuartiles([])
      expect(result).toEqual({ q1: 0, median: 0, q3: 0, iqr: 0 })
    })

    it('should handle unsorted arrays', () => {
      const values = [9, 3, 1, 7, 5]
      const result = calculateQuartiles(values)
      expect(result.median).toBe(5)
    })
  })
})

describe('Z-Score Detection', () => {
  const createMockTraders = (): TraderRankingData[] => [
    { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
    { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: 62, max_drawdown: -6, trades_count: 110, followers: 55, source: 'binance' },
    { id: '3', handle: 't3', roi: 11, pnl: 1100, win_rate: 61, max_drawdown: -5.5, trades_count: 105, followers: 52, source: 'binance' },
    { id: '4', handle: 't4', roi: 10.5, pnl: 1050, win_rate: 59, max_drawdown: -5.2, trades_count: 102, followers: 51, source: 'binance' },
    { id: '6', handle: 't6', roi: 11.5, pnl: 1150, win_rate: 61, max_drawdown: -5.8, trades_count: 108, followers: 53, source: 'binance' },
    { id: '7', handle: 't7', roi: 9.5, pnl: 950, win_rate: 58, max_drawdown: -4.8, trades_count: 98, followers: 48, source: 'binance' },
    { id: '8', handle: 't8', roi: 10.2, pnl: 1020, win_rate: 60, max_drawdown: -5.1, trades_count: 101, followers: 50, source: 'binance' },
    { id: '9', handle: 't9', roi: 11.8, pnl: 1180, win_rate: 63, max_drawdown: -6.2, trades_count: 112, followers: 54, source: 'binance' },
    { id: '10', handle: 't10', roi: 10.8, pnl: 1080, win_rate: 59, max_drawdown: -5.3, trades_count: 103, followers: 51, source: 'binance' },
    { id: '11', handle: 't11', roi: 9.8, pnl: 980, win_rate: 57, max_drawdown: -4.9, trades_count: 97, followers: 49, source: 'binance' },
    { id: '5', handle: 't5', roi: 50, pnl: 5000, win_rate: 95, max_drawdown: -1, trades_count: 500, followers: 200, source: 'binance' }, // Outlier
  ]

  describe('detectByZScore', () => {
    it('should detect outliers in ROI', () => {
      const traders = createMockTraders()
      const results = detectByZScore(traders, 'roi')

      const trader5 = results.get('5')
      expect(trader5).toBeDefined()
      expect(trader5?.isOutlier).toBe(true)
      expect(Math.abs(trader5?.zScore || 0)).toBeGreaterThan(AnomalyConfig.Z_SCORE_THRESHOLD)
    })

    it('should not detect normal values as outliers', () => {
      const traders = createMockTraders()
      const results = detectByZScore(traders, 'roi')

      const trader1 = results.get('1')
      expect(trader1?.isOutlier).toBe(false)
    })

    it('should return empty map for insufficient sample size', () => {
      const traders = createMockTraders().slice(0, 5) // Less than MIN_SAMPLE_SIZE (10)
      const results = detectByZScore(traders, 'roi')

      expect(results.size).toBe(0)
    })

    it('should handle null values gracefully', () => {
      const traders: TraderRankingData[] = [
        { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: null as unknown as number, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
        { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: 60, max_drawdown: -6, trades_count: 110, followers: 55, source: 'binance' },
      ]

      const results = detectByZScore(traders, 'win_rate')
      // Only 1 valid value, below MIN_SAMPLE_SIZE
      expect(results.size).toBe(0)
    })
  })
})

describe('IQR Detection', () => {
  const createMockTraders = (): TraderRankingData[] => [
    { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
    { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: 62, max_drawdown: -6, trades_count: 110, followers: 55, source: 'binance' },
    { id: '3', handle: 't3', roi: 11, pnl: 1100, win_rate: 61, max_drawdown: -5.5, trades_count: 105, followers: 52, source: 'binance' },
    { id: '4', handle: 't4', roi: 10.5, pnl: 1050, win_rate: 59, max_drawdown: -5.2, trades_count: 102, followers: 51, source: 'binance' },
    { id: '7', handle: 't7', roi: 11.5, pnl: 1150, win_rate: 61, max_drawdown: -5.8, trades_count: 108, followers: 53, source: 'binance' },
    { id: '8', handle: 't8', roi: 9.5, pnl: 950, win_rate: 58, max_drawdown: -4.8, trades_count: 98, followers: 48, source: 'binance' },
    { id: '9', handle: 't9', roi: 10.2, pnl: 1020, win_rate: 60, max_drawdown: -5.1, trades_count: 101, followers: 50, source: 'binance' },
    { id: '10', handle: 't10', roi: 11.8, pnl: 1180, win_rate: 63, max_drawdown: -6.2, trades_count: 112, followers: 54, source: 'binance' },
    { id: '11', handle: 't11', roi: 10.8, pnl: 1080, win_rate: 59, max_drawdown: -5.3, trades_count: 103, followers: 51, source: 'binance' },
    { id: '12', handle: 't12', roi: 9.8, pnl: 980, win_rate: 57, max_drawdown: -4.9, trades_count: 97, followers: 49, source: 'binance' },
    { id: '5', handle: 't5', roi: 100, pnl: 10000, win_rate: 95, max_drawdown: -1, trades_count: 1000, followers: 500, source: 'binance' }, // High outlier
    { id: '6', handle: 't6', roi: -50, pnl: -5000, win_rate: 20, max_drawdown: -80, trades_count: 50, followers: 10, source: 'binance' }, // Low outlier
  ]

  describe('detectByIQR', () => {
    it('should detect high outliers', () => {
      const traders = createMockTraders()
      const results = detectByIQR(traders, 'roi')

      const trader5 = results.get('5')
      expect(trader5?.isOutlier).toBe(true)
      expect(trader5?.direction).toBe('high')
    })

    it('should detect low outliers', () => {
      const traders = createMockTraders()
      const results = detectByIQR(traders, 'roi')

      const trader6 = results.get('6')
      expect(trader6?.isOutlier).toBe(true)
      expect(trader6?.direction).toBe('low')
    })

    it('should not detect normal values', () => {
      const traders = createMockTraders()
      const results = detectByIQR(traders, 'roi')

      const trader1 = results.get('1')
      expect(trader1?.isOutlier).toBe(false)
      expect(trader1?.direction).toBeNull()
    })
  })
})

describe('Multi-Dimensional Detection', () => {
  describe('detectMultiDimensional', () => {
    it('should detect statistical outliers', () => {
      const traders: TraderRankingData[] = [
        { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
        { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: 62, max_drawdown: -6, trades_count: 110, followers: 55, source: 'binance' },
        { id: '4', handle: 't4', roi: 11, pnl: 1100, win_rate: 61, max_drawdown: -5.5, trades_count: 105, followers: 52, source: 'binance' },
        { id: '5', handle: 't5', roi: 10.5, pnl: 1050, win_rate: 59, max_drawdown: -5.2, trades_count: 102, followers: 51, source: 'binance' },
        { id: '6', handle: 't6', roi: 11.5, pnl: 1150, win_rate: 61, max_drawdown: -5.8, trades_count: 108, followers: 53, source: 'binance' },
        { id: '7', handle: 't7', roi: 9.5, pnl: 950, win_rate: 58, max_drawdown: -4.8, trades_count: 98, followers: 48, source: 'binance' },
        { id: '8', handle: 't8', roi: 10.2, pnl: 1020, win_rate: 60, max_drawdown: -5.1, trades_count: 101, followers: 50, source: 'binance' },
        { id: '9', handle: 't9', roi: 11.8, pnl: 1180, win_rate: 63, max_drawdown: -6.2, trades_count: 112, followers: 54, source: 'binance' },
        { id: '10', handle: 't10', roi: 10.8, pnl: 1080, win_rate: 59, max_drawdown: -5.3, trades_count: 103, followers: 51, source: 'binance' },
        { id: '11', handle: 't11', roi: 9.8, pnl: 980, win_rate: 57, max_drawdown: -4.9, trades_count: 97, followers: 49, source: 'binance' },
        { id: '3', handle: 't3', roi: 500, pnl: 50000, win_rate: 98, max_drawdown: -0.5, trades_count: 1000, followers: 500, source: 'binance' }, // Multiple outliers
      ]

      const result = detectMultiDimensional(traders[10], traders)

      expect(result.isAnomaly).toBe(true)
      expect(result.anomalyType).toContain('statistical_outlier')
      expect(result.details.length).toBeGreaterThan(0)
    })

    it('should detect data inconsistencies', () => {
      const traders: TraderRankingData[] = [
        { id: '1', handle: 't1', roi: 2000, pnl: 100, win_rate: 150, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' }, // Invalid values
      ]

      const result = detectMultiDimensional(traders[0], traders)

      expect(result.isAnomaly).toBe(true)
      expect(result.anomalyType).toContain('data_inconsistency')
    })

    it('should detect suspicious patterns', () => {
      const traders: TraderRankingData[] = [
        { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
        { id: '2', handle: 't2', roi: 200, pnl: 500, win_rate: 99, max_drawdown: -0.1, trades_count: 2, followers: 1000, source: 'binance' }, // Suspicious
      ]

      const result = detectMultiDimensional(traders[1], traders)

      expect(result.isAnomaly).toBe(true)
      expect(result.anomalyType).toContain('suspicious_pattern')
    })

    it('should not flag normal traders', () => {
      const traders: TraderRankingData[] = [
        { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
        { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: 62, max_drawdown: -6, trades_count: 110, followers: 55, source: 'binance' },
        { id: '3', handle: 't3', roi: 11, pnl: 1100, win_rate: 61, max_drawdown: -5.5, trades_count: 105, followers: 52, source: 'binance' },
      ]

      const result = detectMultiDimensional(traders[0], traders)

      expect(result.isAnomaly).toBe(false)
      expect(result.anomalyScore).toBeLessThan(0.3)
    })
  })
})

describe('Severity Classification', () => {
  describe('classifySeverity', () => {
    it('should classify as critical for Z-Score > 5', () => {
      const severity = classifySeverity(6.0, ['statistical_outlier'], [])
      expect(severity).toBe('critical')
    })

    it('should classify as critical for data inconsistency + other types', () => {
      const severity = classifySeverity(2.0, ['data_inconsistency', 'suspicious_pattern'], [])
      expect(severity).toBe('critical')
    })

    it('should classify as high for Z-Score > 4', () => {
      const severity = classifySeverity(4.5, ['statistical_outlier'], [])
      expect(severity).toBe('high')
    })

    it('should classify as high for suspicious + outlier', () => {
      const severity = classifySeverity(3.5, ['suspicious_pattern', 'statistical_outlier'], [])
      expect(severity).toBe('high')
    })

    it('should classify as medium for Z-Score > 3', () => {
      const severity = classifySeverity(3.5, ['statistical_outlier'], [])
      expect(severity).toBe('medium')
    })

    it('should classify as medium for multiple types', () => {
      const severity = classifySeverity(2.0, ['suspicious_pattern', 'time_series_anomaly'], [])
      expect(severity).toBe('medium')
    })

    it('should classify as low for minor anomalies', () => {
      const severity = classifySeverity(2.0, ['statistical_outlier'], [])
      expect(severity).toBe('low')
    })
  })
})

describe('Time Series Detection', () => {
  describe('detectEquityCurveAnomaly', () => {
    it('should detect sudden jumps in equity curve', () => {
      const equityCurve = [
        100, 102, 104, 106, 108, // Gradual increase
        150, 152, 154, 156, 158, // Sudden jump
      ]

      const result = detectEquityCurveAnomaly(equityCurve, 3)

      expect(result.hasAnomaly).toBe(true)
      expect(result.anomalyPoints.length).toBeGreaterThan(0)
    })

    it('should not detect anomalies in smooth curves', () => {
      const equityCurve = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118]

      const result = detectEquityCurveAnomaly(equityCurve, 3)

      expect(result.hasAnomaly).toBe(false)
      expect(result.anomalyPoints).toEqual([])
    })

    it('should handle insufficient data', () => {
      const equityCurve = [100, 102, 104]

      const result = detectEquityCurveAnomaly(equityCurve, 5)

      expect(result.hasAnomaly).toBe(false)
      expect(result.anomalyPoints).toEqual([])
    })

    it('should handle zero values', () => {
      const equityCurve = [0, 100, 200, 300]

      const result = detectEquityCurveAnomaly(equityCurve, 2)

      // Should handle without errors
      expect(result).toBeDefined()
    })
  })
})

describe('Edge Cases', () => {
  it('should handle traders with missing fields', () => {
    const traders: TraderRankingData[] = [
      { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 0, max_drawdown: 0, trades_count: 0, followers: 50, source: 'binance' },
      { id: '2', handle: 't2', roi: 12, pnl: 1200, win_rate: null as unknown as number, max_drawdown: null as unknown as number, trades_count: null as unknown as number, followers: 55, source: 'binance' },
    ]

    const result = detectMultiDimensional(traders[1], traders)

    // Should not crash
    expect(result).toBeDefined()
    expect(result.traderId).toBe('2')
  })

  it('should handle single trader', () => {
    const traders: TraderRankingData[] = [
      { id: '1', handle: 't1', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
    ]

    const result = detectMultiDimensional(traders[0], traders)

    // Should not detect anomalies with single trader
    expect(result.isAnomaly).toBe(false)
  })

  it('should handle extreme values', () => {
    const traders: TraderRankingData[] = [
      { id: '1', handle: 't1', roi: Number.MAX_SAFE_INTEGER, pnl: Number.MAX_SAFE_INTEGER, win_rate: 100, max_drawdown: -100, trades_count: 1000000, followers: 1000000, source: 'binance' },
      { id: '2', handle: 't2', roi: 10, pnl: 1000, win_rate: 60, max_drawdown: -5, trades_count: 100, followers: 50, source: 'binance' },
    ]

    const result = detectMultiDimensional(traders[0], traders)

    // Should handle extreme values
    expect(result).toBeDefined()
    expect(result.isAnomaly).toBe(true)
  })
})
