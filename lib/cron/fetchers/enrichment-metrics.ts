/**
 * Derived metrics calculations: volatility, drawdown, sharpe ratio, asset breakdown
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail, AssetBreakdown } from './enrichment-types'

/**
 * Calculate volatility from equity curve (standard deviation of daily returns)
 */
export function calculateVolatility(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 3) return null

  const returns: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const prevRoi = curve[i - 1].roi
    const currRoi = curve[i].roi
    const dailyReturn = currRoi - prevRoi
    returns.push(dailyReturn)
  }

  if (returns.length < 2) return null

  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length
  const volatility = Math.sqrt(variance)

  return volatility > 0 && volatility < 200 ? volatility : null
}

/**
 * Calculate current drawdown from equity curve
 */
export function calculateCurrentDrawdown(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 2) return null

  let peakRoi = curve[0].roi
  for (const point of curve) {
    if (point.roi > peakRoi) {
      peakRoi = point.roi
    }
  }

  const currentRoi = curve[curve.length - 1].roi

  if (peakRoi <= 0) return null

  const drawdown = peakRoi - currentRoi
  return drawdown > 0 ? drawdown : 0
}

/**
 * Calculate max drawdown from equity curve
 */
export function calculateMaxDrawdown(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 2) return null

  let peakRoi = curve[0].roi
  let maxDD = 0

  for (const point of curve) {
    if (point.roi > peakRoi) {
      peakRoi = point.roi
    }
    const dd = peakRoi - point.roi
    if (dd > maxDD) {
      maxDD = dd
    }
  }

  return maxDD > 0 ? Math.min(maxDD, 100) : null
}

/**
 * Calculate Sharpe ratio from equity curve (simplified, risk-free rate = 0)
 */
export function calculateSharpeRatio(curve: EquityCurvePoint[], _period: string): number | null {
  if (curve.length < 7) return null

  const returns: number[] = []
  for (let i = 1; i < curve.length; i++) {
    const dailyReturn = curve[i].roi - curve[i - 1].roi
    returns.push(dailyReturn)
  }

  if (returns.length < 5) return null

  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length
  const stdDev = Math.sqrt(variance)

  if (stdDev === 0) return null

  const annualizationFactor = Math.sqrt(365)
  const sharpe = (meanReturn / stdDev) * annualizationFactor

  return sharpe > -10 && sharpe < 10 ? Math.round(sharpe * 100) / 100 : null
}

/**
 * Enhance stats detail with derived metrics from equity curve
 */
export function enhanceStatsWithDerivedMetrics(
  stats: StatsDetail,
  curve: EquityCurvePoint[],
  period: string
): StatsDetail {
  if (!stats.volatility && curve.length >= 3) {
    stats.volatility = calculateVolatility(curve)
  }

  if (!stats.currentDrawdown && curve.length >= 2) {
    stats.currentDrawdown = calculateCurrentDrawdown(curve)
  }

  if (!stats.maxDrawdown && curve.length >= 2) {
    const calculatedMdd = calculateMaxDrawdown(curve)
    if (calculatedMdd) {
      stats.maxDrawdown = calculatedMdd
    }
  }

  if (!stats.sharpeRatio && curve.length >= 7) {
    stats.sharpeRatio = calculateSharpeRatio(curve, period)
  }

  return stats
}

/**
 * Calculate asset breakdown from position history
 */
export function calculateAssetBreakdown(positions: PositionHistoryItem[]): AssetBreakdown[] {
  if (positions.length === 0) return []

  const symbolCounts = new Map<string, number>()
  for (const pos of positions) {
    const symbol = pos.symbol.replace(/USDT$|USD$|BUSD$|PERP$/i, '')
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1)
  }

  const total = positions.length
  const breakdown: AssetBreakdown[] = []

  for (const [symbol, count] of Array.from(symbolCounts.entries())) {
    breakdown.push({
      symbol,
      weightPct: (count / total) * 100,
    })
  }

  breakdown.sort((a, b) => b.weightPct - a.weightPct)
  return breakdown.slice(0, 10)
}
