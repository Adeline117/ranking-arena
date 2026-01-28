/**
 * Anomaly Detection Helper for Import Scripts
 * Provides easy integration for .mjs scripts
 *
 * Usage:
 *   import { detectAndSaveAnomalies } from './lib/services/anomaly-helper.mjs'
 *   await detectAndSaveAnomalies(traders, platform)
 *
 * @module lib/services/anomaly-helper
 */

import { createClient } from '@supabase/supabase-js'

// ============================================
// Configuration
// ============================================

const ANOMALY_CONFIG = {
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

// ============================================
// Statistical Utilities
// ============================================

function calculateMean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function calculateStdDev(values, mean) {
  if (values.length < 2) return 0
  const m = mean ?? calculateMean(values)
  const squaredDiffs = values.map(v => Math.pow(v - m, 2))
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1))
}

function calculateZScore(value, mean, stdDev) {
  if (stdDev === 0) return 0
  return (value - mean) / stdDev
}

// ============================================
// Detection Logic
// ============================================

function detectDataInconsistency(trader) {
  const details = []
  const { THRESHOLDS } = ANOMALY_CONFIG

  if (trader.roi > THRESHOLDS.ROI_MAX) {
    details.push({
      field: 'roi',
      value: trader.roi,
      description: `ROI (${trader.roi.toFixed(2)}%) exceeds normal range (>${THRESHOLDS.ROI_MAX}%)`,
    })
  }

  if (trader.roi < THRESHOLDS.ROI_MIN) {
    details.push({
      field: 'roi',
      value: trader.roi,
      description: `ROI (${trader.roi.toFixed(2)}%) below normal range (<${THRESHOLDS.ROI_MIN}%)`,
    })
  }

  if (trader.win_rate != null) {
    if (trader.win_rate > THRESHOLDS.WIN_RATE_MAX || trader.win_rate < THRESHOLDS.WIN_RATE_MIN) {
      details.push({
        field: 'win_rate',
        value: trader.win_rate,
        description: `Win rate (${trader.win_rate.toFixed(2)}%) outside valid range (0-100%)`,
      })
    }
  }

  if (trader.pnl < THRESHOLDS.MIN_PNL_FOR_HIGH_ROI && trader.roi > 100) {
    details.push({
      field: 'pnl',
      value: trader.pnl,
      description: `Low PnL ($${trader.pnl.toFixed(0)}) with high ROI (${trader.roi.toFixed(2)}%)`,
    })
  }

  return details
}

function detectSuspiciousPatterns(trader) {
  const details = []
  const { THRESHOLDS } = ANOMALY_CONFIG

  if (trader.win_rate != null && trader.win_rate > THRESHOLDS.WIN_RATE_SUSPICIOUS) {
    details.push({
      field: 'win_rate',
      value: trader.win_rate,
      description: `Suspiciously high win rate (${trader.win_rate.toFixed(2)}%)`,
    })
  }

  if (trader.max_drawdown != null) {
    const absDrawdown = Math.abs(trader.max_drawdown)
    if (absDrawdown < THRESHOLDS.DRAWDOWN_SUSPICIOUS_LOW && trader.roi > 50) {
      details.push({
        field: 'max_drawdown',
        value: trader.max_drawdown,
        description: `Almost no drawdown (${absDrawdown.toFixed(2)}%) with high ROI (${trader.roi.toFixed(2)}%)`,
      })
    }
  }

  if (trader.trades_count != null && trader.trades_count < THRESHOLDS.TRADES_MIN && trader.roi > 100) {
    details.push({
      field: 'trades_count',
      value: trader.trades_count,
      description: `Very few trades (${trader.trades_count}) with high ROI (${trader.roi.toFixed(2)}%)`,
    })
  }

  return details
}

function detectByZScore(traders, field) {
  const results = new Map()

  const validValues = []
  for (const trader of traders) {
    const value = trader[field]
    if (value != null && !isNaN(value)) {
      validValues.push({ id: trader.id, value })
    }
  }

  if (validValues.length < ANOMALY_CONFIG.MIN_SAMPLE_SIZE) {
    return results
  }

  const values = validValues.map(v => v.value)
  const mean = calculateMean(values)
  const stdDev = calculateStdDev(values, mean)

  for (const { id, value } of validValues) {
    const zScore = calculateZScore(value, mean, stdDev)
    results.set(id, {
      zScore,
      isOutlier: Math.abs(zScore) > ANOMALY_CONFIG.Z_SCORE_THRESHOLD,
    })
  }

  return results
}

function classifySeverity(maxZScore, anomalyTypes) {
  const absZScore = Math.abs(maxZScore || 0)

  if (absZScore > ANOMALY_CONFIG.SEVERITY.CRITICAL_Z_SCORE) return 'critical'
  if (anomalyTypes.includes('data_inconsistency') && anomalyTypes.length >= 2) return 'critical'
  if (absZScore > ANOMALY_CONFIG.SEVERITY.HIGH_Z_SCORE) return 'high'
  if (anomalyTypes.includes('suspicious_pattern') && anomalyTypes.includes('statistical_outlier')) return 'high'
  if (absZScore > ANOMALY_CONFIG.SEVERITY.MEDIUM_Z_SCORE) return 'medium'
  if (anomalyTypes.length >= 2) return 'medium'

  return 'low'
}

function detectMultiDimensional(trader, allTraders) {
  const details = []
  const anomalyTypes = []
  let totalAnomalyScore = 0
  let weightSum = 0
  let maxZScore = 0

  const fields = ['roi', 'win_rate', 'max_drawdown', 'trades_count', 'pnl']

  for (const field of fields) {
    const value = trader[field]
    if (value == null) continue

    const zScoreResults = detectByZScore(allTraders, field)
    const result = zScoreResults.get(trader.id)

    if (result) {
      const weight = ANOMALY_CONFIG.WEIGHTS[field]
      weightSum += weight
      maxZScore = Math.max(maxZScore, Math.abs(result.zScore))

      if (result.isOutlier) {
        totalAnomalyScore += weight * Math.min(Math.abs(result.zScore) / 5, 1)

        details.push({
          field,
          value,
          zScore: result.zScore,
          description: `${field} Z-Score: ${result.zScore.toFixed(2)}`,
        })

        if (!anomalyTypes.includes('statistical_outlier')) {
          anomalyTypes.push('statistical_outlier')
        }
      }
    }
  }

  const inconsistencies = detectDataInconsistency(trader)
  if (inconsistencies.length > 0) {
    anomalyTypes.push('data_inconsistency')
    details.push(...inconsistencies)
    totalAnomalyScore += 0.3 * inconsistencies.length
    weightSum += 0.3 * inconsistencies.length
  }

  const suspiciousPatterns = detectSuspiciousPatterns(trader)
  if (suspiciousPatterns.length > 0) {
    anomalyTypes.push('suspicious_pattern')
    details.push(...suspiciousPatterns)
    totalAnomalyScore += 0.25 * suspiciousPatterns.length
    weightSum += 0.25 * suspiciousPatterns.length
  }

  const anomalyScore = weightSum > 0 ? Math.min(totalAnomalyScore / weightSum, 1) : 0
  const severity = classifySeverity(maxZScore, anomalyTypes)

  return {
    traderId: trader.id,
    isAnomaly: anomalyScore > 0.3 || anomalyTypes.length >= 2,
    anomalyScore,
    anomalyType: anomalyTypes,
    severity,
    details,
  }
}

// ============================================
// Public API
// ============================================

/**
 * Detect and save anomalies for a batch of traders
 */
export async function detectAndSaveAnomalies(traders, platform) {
  // Check if anomaly detection is enabled
  const enabled = process.env.ENABLE_ANOMALY_DETECTION !== 'false'
  if (!enabled) {
    return { detected: 0, saved: 0 }
  }

  if (traders.length === 0) {
    return { detected: 0, saved: 0 }
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Anomaly] Missing Supabase credentials, skipping')
    return { detected: 0, saved: 0 }
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  let detectedCount = 0
  let savedCount = 0

  for (const trader of traders) {
    const result = detectMultiDimensional(trader, traders)

    if (result.isAnomaly) {
      detectedCount++

      // Convert to database format
      const anomalies = result.details.map(detail => ({
        trader_id: trader.id,
        platform,
        anomaly_type: result.anomalyType.join(','),
        field_name: detail.field,
        detected_value: detail.value,
        z_score: detail.zScore ?? null,
        severity: result.severity,
        status: 'pending',
        description: detail.description,
        metadata: {
          anomaly_score: result.anomalyScore,
        },
      }))

      // Save to database
      const { error } = await supabase
        .from('trader_anomalies')
        .insert(anomalies)

      if (error) {
        console.error(`[Anomaly] Failed to save for ${trader.id}:`, error.message)
      } else {
        savedCount += anomalies.length
      }
    }
  }

  return { detected: detectedCount, saved: savedCount }
}

/**
 * Check if a trader has critical anomalies
 */
export async function hasCAnomalies(traderId, platform) {
  const enabled = process.env.ENABLE_ANOMALY_DETECTION !== 'false'
  if (!enabled) return false

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) return false

  const supabase = createClient(supabaseUrl, supabaseKey)

  const { data } = await supabase
    .from('trader_anomalies')
    .select('id')
    .eq('trader_id', traderId)
    .eq('platform', platform)
    .in('severity', ['critical', 'high'])
    .eq('status', 'pending')
    .limit(1)

  return (data?.length || 0) > 0
}
