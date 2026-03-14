/**
 * Anomaly Detection for Trader Data
 * 
 * Detects suspicious or abnormal values in trader statistics
 */

export interface AnomalyResult {
  field: string
  value: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  reason: string
  suggestion?: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderDataForAnomaly {
  roi?: number | null
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers?: number | null
  arena_score?: number | null
}

// Thresholds for anomaly detection
const THRESHOLDS = {
  roi: {
    suspiciousHigh: 50000,   // 50,000% ROI is suspicious
    criticalHigh: 100000,   // 100,000% ROI is almost certainly an error
    suspiciousLow: -99,     // More than 99% loss is suspicious
  },
  pnl: {
    suspiciousHigh: 100_000_000, // $100M PnL is suspicious for most traders
  },
  winRate: {
    suspiciousHigh: 99,     // 99% win rate is suspicious
    suspiciousLow: 1,       // 1% win rate with many trades is suspicious
  },
  maxDrawdown: {
    suspiciousHigh: 99,     // 99% drawdown but still trading is suspicious
    impossibleHigh: 100,    // 100% drawdown means account wiped
  },
  tradesCount: {
    suspiciousHigh: 100000, // 100K trades in 30 days = 3,333/day
    suspiciousLowForHighWR: 5, // High win rate with very few trades
  },
  arenaScore: {
    suspiciousHigh: 150,    // Score should max out around 100
  },
}

/**
 * Detect anomalies in trader data
 */
export function detectAnomalies(data: TraderDataForAnomaly): AnomalyResult[] {
  const anomalies: AnomalyResult[] = []

  // ROI anomalies
  if (data.roi !== null && data.roi !== undefined) {
    if (data.roi >= THRESHOLDS.roi.criticalHigh) {
      anomalies.push({
        field: 'roi',
        value: data.roi,
        severity: 'critical',
        reason: `ROI of ${data.roi.toLocaleString()}% is unrealistic`,
        suggestion: 'This may be a data import error (e.g., PnL stored as ROI)',
      })
    } else if (data.roi >= THRESHOLDS.roi.suspiciousHigh) {
      anomalies.push({
        field: 'roi',
        value: data.roi,
        severity: 'high',
        reason: `Extremely high ROI of ${data.roi.toLocaleString()}%`,
        suggestion: 'Verify data source or flag for manual review',
      })
    } else if (data.roi <= THRESHOLDS.roi.suspiciousLow) {
      anomalies.push({
        field: 'roi',
        value: data.roi,
        severity: 'medium',
        reason: `Near-total loss of ${data.roi.toFixed(2)}%`,
        suggestion: 'Account may be blown, consider excluding from rankings',
      })
    }
  }

  // Win Rate anomalies
  if (data.win_rate !== null && data.win_rate !== undefined) {
    if (data.win_rate > 100 || data.win_rate < 0) {
      anomalies.push({
        field: 'win_rate',
        value: data.win_rate,
        severity: 'critical',
        reason: `Invalid win rate: ${data.win_rate}% (must be 0-100)`,
        suggestion: 'Data format error - win rate may not be in percentage',
      })
    } else if (data.win_rate >= THRESHOLDS.winRate.suspiciousHigh) {
      // High win rate with low trades is more suspicious
      if (data.trades_count && data.trades_count < THRESHOLDS.tradesCount.suspiciousLowForHighWR) {
        anomalies.push({
          field: 'win_rate',
          value: data.win_rate,
          severity: 'medium',
          reason: `${data.win_rate}% win rate with only ${data.trades_count} trades`,
          suggestion: 'Insufficient sample size for reliable statistics',
        })
      }
    }
  }

  // Max Drawdown anomalies
  if (data.max_drawdown !== null && data.max_drawdown !== undefined) {
    const ddValue = Math.abs(data.max_drawdown)
    if (ddValue > 100) {
      anomalies.push({
        field: 'max_drawdown',
        value: data.max_drawdown,
        severity: 'critical',
        reason: `Invalid drawdown: ${ddValue}% (cannot exceed 100%)`,
        suggestion: 'Data format error',
      })
    } else if (ddValue >= THRESHOLDS.maxDrawdown.impossibleHigh) {
      anomalies.push({
        field: 'max_drawdown',
        value: data.max_drawdown,
        severity: 'high',
        reason: '100% drawdown indicates account wipeout',
        suggestion: 'Trader may have recovered from margin call or data is incorrect',
      })
    }
  }

  // Arena Score anomalies
  if (data.arena_score !== null && data.arena_score !== undefined) {
    if (data.arena_score > THRESHOLDS.arenaScore.suspiciousHigh) {
      anomalies.push({
        field: 'arena_score',
        value: data.arena_score,
        severity: 'high',
        reason: `Arena score ${data.arena_score} exceeds expected maximum`,
        suggestion: 'Recalculate score with updated formula',
      })
    } else if (data.arena_score < 0) {
      anomalies.push({
        field: 'arena_score',
        value: data.arena_score,
        severity: 'critical',
        reason: 'Negative arena score',
        suggestion: 'Calculation error in scoring',
      })
    }
  }

  // Trades count anomalies
  if (data.trades_count !== null && data.trades_count !== undefined) {
    if (data.trades_count >= THRESHOLDS.tradesCount.suspiciousHigh) {
      anomalies.push({
        field: 'trades_count',
        value: data.trades_count,
        severity: 'medium',
        reason: `Extremely high trade count: ${data.trades_count.toLocaleString()}`,
        suggestion: 'May be a high-frequency bot or data aggregation error',
      })
    }
  }

  return anomalies
}

/**
 * Calculate anomaly score (0-100, higher = more anomalous)
 */
export function calculateAnomalyScore(anomalies: AnomalyResult[]): number {
  if (anomalies.length === 0) return 0

  const severityWeights = {
    low: 5,
    medium: 15,
    high: 35,
    critical: 50,
  }

  const totalWeight = anomalies.reduce((sum, a) => sum + severityWeights[a.severity], 0)
  return Math.min(100, totalWeight)
}

/**
 * Check if data should be flagged for review
 */
export function shouldFlagForReview(anomalies: AnomalyResult[]): boolean {
  return anomalies.some(a => a.severity === 'critical' || a.severity === 'high')
}

/**
 * Filter valid records (exclude critically anomalous)
 */
export function isValidRecord(data: TraderDataForAnomaly): boolean {
  const anomalies = detectAnomalies(data)
  return !anomalies.some(a => a.severity === 'critical')
}
