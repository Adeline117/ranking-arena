/**
 * Anomaly Detection Service
 * Provides multiple anomaly detection algorithms for trader data quality monitoring
 *
 * Features:
 * - Z-Score based statistical outlier detection
 * - IQR (Interquartile Range) based outlier detection
 * - Multi-dimensional anomaly detection
 * - Data inconsistency detection
 * - Suspicious pattern detection
 * - Time series anomaly detection
 *
 * @module lib/services/anomaly-detection
 */

import type { TraderRankingData } from '../utils/ranking'

// ============================================
// Types & Interfaces
// ============================================

export type AnomalyType =
  | 'statistical_outlier'    // Statistical anomaly (Z-Score or IQR)
  | 'data_inconsistency'     // Data validation errors
  | 'suspicious_pattern'     // Suspicious trading patterns
  | 'time_series_anomaly'    // Time-based anomalies
  | 'behavioral_anomaly'     // Unusual behavior patterns

export type SeverityLevel = 'low' | 'medium' | 'high' | 'critical'

export interface AnomalyDetail {
  field: string
  value: number
  zScore?: number
  threshold?: number
  description: string
}

export interface AnomalyResult {
  traderId: string
  isAnomaly: boolean
  anomalyScore: number      // 0-1, higher = more anomalous
  anomalyType: AnomalyType[]
  severity: SeverityLevel
  confidence: number        // 0-1
  details: AnomalyDetail[]
}

// ============================================
// Configuration
// ============================================

export interface AnomalyConfig {
  Z_SCORE_THRESHOLD: number
  IQR_MULTIPLIER: number
  MIN_SAMPLE_SIZE: number
  WEIGHTS: {
    roi: number
    win_rate: number
    max_drawdown: number
    trades_count: number
    pnl: number
  }
  THRESHOLDS: {
    ROI_MAX: number
    ROI_MIN: number
    WIN_RATE_MAX: number
    WIN_RATE_MIN: number
    WIN_RATE_SUSPICIOUS: number
    DRAWDOWN_SUSPICIOUS_LOW: number
    TRADES_MIN: number
    MIN_PNL_FOR_HIGH_ROI: number
  }
  SEVERITY: {
    CRITICAL_Z_SCORE: number
    HIGH_Z_SCORE: number
    MEDIUM_Z_SCORE: number
  }
}

// Default configuration (can be overridden via environment variables)
const DEFAULT_CONFIG: AnomalyConfig = {
  Z_SCORE_THRESHOLD: parseFloat(process.env.ANOMALY_DETECTION_Z_SCORE_THRESHOLD || '2.5'),
  IQR_MULTIPLIER: parseFloat(process.env.ANOMALY_DETECTION_IQR_MULTIPLIER || '1.5'),
  MIN_SAMPLE_SIZE: parseInt(process.env.ANOMALY_DETECTION_MIN_SAMPLE_SIZE || '10'),

  WEIGHTS: {
    roi: 0.35,
    win_rate: 0.2,
    max_drawdown: 0.25,
    trades_count: 0.1,
    pnl: 0.1,
  },

  THRESHOLDS: {
    ROI_MAX: 1000,
    ROI_MIN: -99,
    WIN_RATE_MAX: 100,
    WIN_RATE_MIN: 0,
    WIN_RATE_SUSPICIOUS: 95,
    DRAWDOWN_SUSPICIOUS_LOW: 1,
    TRADES_MIN: 3,
    MIN_PNL_FOR_HIGH_ROI: 1000,
  },

  SEVERITY: {
    CRITICAL_Z_SCORE: 5.0,
    HIGH_Z_SCORE: 4.0,
    MEDIUM_Z_SCORE: 3.0,
  },
}

export const AnomalyConfig = DEFAULT_CONFIG

// ============================================
// Statistical Utilities
// ============================================

export function calculateMean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

export function calculateStdDev(values: number[], mean?: number): number {
  if (values.length < 2) return 0
  const m = mean ?? calculateMean(values)
  const squaredDiffs = values.map(v => Math.pow(v - m, 2))
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1))
}

export function calculateZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0
  return (value - mean) / stdDev
}

export function calculateQuartiles(values: number[]): {
  q1: number
  median: number
  q3: number
  iqr: number
} {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length

  if (n === 0) return { q1: 0, median: 0, q3: 0, iqr: 0 }

  const q1Index = Math.floor(n * 0.25)
  const medianIndex = Math.floor(n * 0.5)
  const q3Index = Math.floor(n * 0.75)

  const q1 = sorted[q1Index]
  const median = sorted[medianIndex]
  const q3 = sorted[q3Index]

  return { q1, median, q3, iqr: q3 - q1 }
}

// ============================================
// Severity Classification
// ============================================

export function classifySeverity(
  zScore: number | null,
  anomalyTypes: AnomalyType[],
  _details: AnomalyDetail[]
): SeverityLevel {
  const absZScore = Math.abs(zScore || 0)

  // Critical: Z-Score > 5 OR multiple severe anomalies
  if (absZScore > AnomalyConfig.SEVERITY.CRITICAL_Z_SCORE) {
    return 'critical'
  }

  if (anomalyTypes.includes('data_inconsistency') && anomalyTypes.length >= 2) {
    return 'critical'
  }

  // High: Z-Score > 4 OR suspicious pattern + outlier
  if (absZScore > AnomalyConfig.SEVERITY.HIGH_Z_SCORE) {
    return 'high'
  }

  if (anomalyTypes.includes('suspicious_pattern') && anomalyTypes.includes('statistical_outlier')) {
    return 'high'
  }

  // Medium: Z-Score > 3 OR multiple minor anomalies
  if (absZScore > AnomalyConfig.SEVERITY.MEDIUM_Z_SCORE) {
    return 'medium'
  }

  if (anomalyTypes.length >= 2) {
    return 'medium'
  }

  // Low: everything else
  return 'low'
}

// ============================================
// Z-Score Detection
// ============================================

type TraderFieldKey = 'roi' | 'win_rate' | 'max_drawdown' | 'trades_count' | 'pnl'

export function detectByZScore(
  traders: TraderRankingData[],
  field: TraderFieldKey,
  threshold: number = AnomalyConfig.Z_SCORE_THRESHOLD
): Map<string, { zScore: number; isOutlier: boolean }> {
  const results = new Map<string, { zScore: number; isOutlier: boolean }>()

  // Extract valid values
  const validValues: { id: string; value: number }[] = []
  for (const trader of traders) {
    const value = trader[field]
    if (value != null && !isNaN(value)) {
      validValues.push({ id: trader.id, value })
    }
  }

  if (validValues.length < AnomalyConfig.MIN_SAMPLE_SIZE) {
    return results
  }

  // Calculate statistics
  const values = validValues.map(v => v.value)
  const mean = calculateMean(values)
  const stdDev = calculateStdDev(values, mean)

  // Calculate Z-Score for each trader
  for (const { id, value } of validValues) {
    const zScore = calculateZScore(value, mean, stdDev)
    results.set(id, {
      zScore,
      isOutlier: Math.abs(zScore) > threshold,
    })
  }

  return results
}

// ============================================
// IQR Detection
// ============================================

export function detectByIQR(
  traders: TraderRankingData[],
  field: TraderFieldKey,
  multiplier: number = AnomalyConfig.IQR_MULTIPLIER
): Map<string, { isOutlier: boolean; direction: 'high' | 'low' | null }> {
  const results = new Map<string, { isOutlier: boolean; direction: 'high' | 'low' | null }>()

  const validValues: { id: string; value: number }[] = []
  for (const trader of traders) {
    const value = trader[field]
    if (value != null && !isNaN(value)) {
      validValues.push({ id: trader.id, value })
    }
  }

  if (validValues.length < AnomalyConfig.MIN_SAMPLE_SIZE) {
    return results
  }

  const values = validValues.map(v => v.value)
  const { q1, q3, iqr } = calculateQuartiles(values)

  const lowerBound = q1 - multiplier * iqr
  const upperBound = q3 + multiplier * iqr

  for (const { id, value } of validValues) {
    let direction: 'high' | 'low' | null = null
    let isOutlier = false

    if (value < lowerBound) {
      isOutlier = true
      direction = 'low'
    } else if (value > upperBound) {
      isOutlier = true
      direction = 'high'
    }

    results.set(id, { isOutlier, direction })
  }

  return results
}

// ============================================
// Data Inconsistency Detection
// ============================================

function detectDataInconsistency(trader: TraderRankingData): AnomalyDetail[] {
  const details: AnomalyDetail[] = []
  const { THRESHOLDS } = AnomalyConfig

  // ROI range check
  if (trader.roi > THRESHOLDS.ROI_MAX) {
    details.push({
      field: 'roi',
      value: trader.roi,
      threshold: THRESHOLDS.ROI_MAX,
      description: `ROI (${trader.roi.toFixed(2)}%) exceeds normal range (>${THRESHOLDS.ROI_MAX}%)`,
    })
  }

  if (trader.roi < THRESHOLDS.ROI_MIN) {
    details.push({
      field: 'roi',
      value: trader.roi,
      threshold: THRESHOLDS.ROI_MIN,
      description: `ROI (${trader.roi.toFixed(2)}%) below normal range (<${THRESHOLDS.ROI_MIN}%)`,
    })
  }

  // Win rate validation
  if (trader.win_rate != null) {
    if (trader.win_rate > THRESHOLDS.WIN_RATE_MAX || trader.win_rate < THRESHOLDS.WIN_RATE_MIN) {
      details.push({
        field: 'win_rate',
        value: trader.win_rate,
        description: `Win rate (${trader.win_rate.toFixed(2)}%) outside valid range (0-100%)`,
      })
    }
  }

  // Low PnL with high ROI
  if (trader.pnl < THRESHOLDS.MIN_PNL_FOR_HIGH_ROI && trader.roi > 100) {
    details.push({
      field: 'pnl',
      value: trader.pnl,
      threshold: THRESHOLDS.MIN_PNL_FOR_HIGH_ROI,
      description: `Low PnL ($${trader.pnl.toFixed(0)}) with high ROI (${trader.roi.toFixed(2)}%)`,
    })
  }

  return details
}

// ============================================
// Suspicious Pattern Detection
// ============================================

function detectSuspiciousPatterns(trader: TraderRankingData): AnomalyDetail[] {
  const details: AnomalyDetail[] = []
  const { THRESHOLDS } = AnomalyConfig

  // Extremely high win rate
  if (trader.win_rate != null && trader.win_rate > THRESHOLDS.WIN_RATE_SUSPICIOUS) {
    details.push({
      field: 'win_rate',
      value: trader.win_rate,
      threshold: THRESHOLDS.WIN_RATE_SUSPICIOUS,
      description: `Suspiciously high win rate (${trader.win_rate.toFixed(2)}%), possible data quality issue`,
    })
  }

  // Almost no drawdown with high ROI
  if (trader.max_drawdown != null) {
    const absDrawdown = Math.abs(trader.max_drawdown)
    if (absDrawdown < THRESHOLDS.DRAWDOWN_SUSPICIOUS_LOW && trader.roi > 50) {
      details.push({
        field: 'max_drawdown',
        value: trader.max_drawdown,
        threshold: THRESHOLDS.DRAWDOWN_SUSPICIOUS_LOW,
        description: `Almost no drawdown (${absDrawdown.toFixed(2)}%) with high ROI (${trader.roi.toFixed(2)}%)`,
      })
    }
  }

  // Very few trades with high ROI
  if (trader.trades_count != null && trader.trades_count < THRESHOLDS.TRADES_MIN && trader.roi > 100) {
    details.push({
      field: 'trades_count',
      value: trader.trades_count,
      threshold: THRESHOLDS.TRADES_MIN,
      description: `Very few trades (${trader.trades_count}) with high ROI (${trader.roi.toFixed(2)}%)`,
    })
  }

  return details
}

// ============================================
// Confidence Calculation
// ============================================

function calculateConfidence(sampleSize: number, anomalyTypeCount: number): number {
  // Sample size impact on confidence
  const sampleConfidence = Math.min(sampleSize / 100, 1)

  // Multiple anomaly types increase confidence
  const typeConfidence = Math.min(anomalyTypeCount / 3, 1) * 0.3 + 0.7

  return sampleConfidence * typeConfidence
}

// ============================================
// Multi-Dimensional Detection
// ============================================

export function detectMultiDimensional(
  trader: TraderRankingData,
  allTraders: TraderRankingData[]
): AnomalyResult {
  const details: AnomalyDetail[] = []
  const anomalyTypes: AnomalyType[] = []
  let totalAnomalyScore = 0
  let weightSum = 0
  let maxZScore = 0

  // 1. Z-Score detection for each field
  const fields: TraderFieldKey[] = ['roi', 'win_rate', 'max_drawdown', 'trades_count', 'pnl']

  for (const field of fields) {
    const value = trader[field]
    if (value == null) continue

    const zScoreResults = detectByZScore(allTraders, field)
    const result = zScoreResults.get(trader.id)

    if (result) {
      const weight = AnomalyConfig.WEIGHTS[field]
      weightSum += weight
      maxZScore = Math.max(maxZScore, Math.abs(result.zScore))

      if (result.isOutlier) {
        totalAnomalyScore += weight * Math.min(Math.abs(result.zScore) / 5, 1)

        details.push({
          field,
          value,
          zScore: result.zScore,
          threshold: AnomalyConfig.Z_SCORE_THRESHOLD,
          description: `${field} Z-Score: ${result.zScore.toFixed(2)} (threshold: ±${AnomalyConfig.Z_SCORE_THRESHOLD})`,
        })

        if (!anomalyTypes.includes('statistical_outlier')) {
          anomalyTypes.push('statistical_outlier')
        }
      }
    }
  }

  // 2. Data inconsistency detection
  const inconsistencies = detectDataInconsistency(trader)
  if (inconsistencies.length > 0) {
    anomalyTypes.push('data_inconsistency')
    details.push(...inconsistencies)
    totalAnomalyScore += 0.3 * inconsistencies.length
    weightSum += 0.3 * inconsistencies.length
  }

  // 3. Suspicious pattern detection
  const suspiciousPatterns = detectSuspiciousPatterns(trader)
  if (suspiciousPatterns.length > 0) {
    anomalyTypes.push('suspicious_pattern')
    details.push(...suspiciousPatterns)
    totalAnomalyScore += 0.25 * suspiciousPatterns.length
    weightSum += 0.25 * suspiciousPatterns.length
  }

  // Calculate final anomaly score
  const anomalyScore = weightSum > 0 ? Math.min(totalAnomalyScore / weightSum, 1) : 0

  // Calculate confidence
  const confidence = calculateConfidence(allTraders.length, anomalyTypes.length)

  // Classify severity
  const severity = classifySeverity(maxZScore, anomalyTypes, details)

  return {
    traderId: trader.id,
    isAnomaly: anomalyScore > 0.3 || anomalyTypes.length >= 2,
    anomalyScore,
    anomalyType: anomalyTypes,
    severity,
    confidence,
    details,
  }
}

// ============================================
// Time Series Detection
// ============================================

export function detectEquityCurveAnomaly(
  equityCurve: number[],
  windowSize: number = 5
): { hasAnomaly: boolean; anomalyPoints: number[] } {
  const anomalyPoints: number[] = []

  if (equityCurve.length < windowSize * 2) {
    return { hasAnomaly: false, anomalyPoints }
  }

  // Calculate returns
  const returns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] !== 0) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1] * 100)
    }
  }

  // Sliding window detection
  for (let i = windowSize; i < returns.length - windowSize; i++) {
    const windowBefore = returns.slice(i - windowSize, i)
    const windowAfter = returns.slice(i, i + windowSize)

    const meanBefore = calculateMean(windowBefore)
    const meanAfter = calculateMean(windowAfter)
    const stdBefore = calculateStdDev(windowBefore, meanBefore)

    // Mark as anomaly if mean shift > 3 std devs
    if (stdBefore > 0 && Math.abs(meanAfter - meanBefore) > 3 * stdBefore) {
      anomalyPoints.push(i)
    }
  }

  return {
    hasAnomaly: anomalyPoints.length > 0,
    anomalyPoints,
  }
}

// ============================================
// Batch Detection
// ============================================

export function detectAnomaliesForAll(traders: TraderRankingData[]): Map<string, AnomalyResult> {
  const results = new Map<string, AnomalyResult>()

  for (const trader of traders) {
    const result = detectMultiDimensional(trader, traders)
    results.set(trader.id, result)
  }

  return results
}

export function getAnomalousTraders(traders: TraderRankingData[]): AnomalyResult[] {
  const allResults = detectAnomaliesForAll(traders)
  const anomalous: AnomalyResult[] = []

  for (const result of allResults.values()) {
    if (result.isAnomaly) {
      anomalous.push(result)
    }
  }

  // Sort by anomaly score (highest first)
  return anomalous.sort((a, b) => b.anomalyScore - a.anomalyScore)
}
