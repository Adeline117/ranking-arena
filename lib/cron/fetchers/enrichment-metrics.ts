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
 * Calculate average holding time from position history.
 * Returns hours (e.g. 24.5 for 1 day, 0.5 for 30 min).
 */
export function calculateAvgHoldingHours(positions: PositionHistoryItem[]): number | null {
  const withTimes = positions.filter(p => p.openTime && p.closeTime)
  if (withTimes.length < 2) return null

  let totalHours = 0
  let count = 0
  for (const p of withTimes) {
    const open = new Date(p.openTime!).getTime()
    const close = new Date(p.closeTime!).getTime()
    if (close > open) {
      totalHours += (close - open) / 3600000
      count++
    }
  }

  if (count === 0) return null
  const avg = totalHours / count
  return avg > 0 && avg < 100000 ? Math.round(avg * 100) / 100 : null
}

/**
 * Calculate avg profit and avg loss from position history
 */
export function calculateAvgProfitLoss(positions: PositionHistoryItem[]): {
  avgProfit: number | null
  avgLoss: number | null
  largestWin: number | null
  largestLoss: number | null
} {
  const withPnl = positions.filter(p => p.pnlUsd != null)
  if (withPnl.length < 2) return { avgProfit: null, avgLoss: null, largestWin: null, largestLoss: null }

  const profits = withPnl.filter(p => (p.pnlUsd ?? 0) > 0).map(p => p.pnlUsd!)
  const losses = withPnl.filter(p => (p.pnlUsd ?? 0) < 0).map(p => p.pnlUsd!)

  return {
    avgProfit: profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : null,
    avgLoss: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    largestWin: profits.length > 0 ? Math.max(...profits) : null,
    largestLoss: losses.length > 0 ? Math.min(...losses) : null,
  }
}

/**
 * Enhance stats detail with derived metrics from equity curve AND position history
 */
export function enhanceStatsWithDerivedMetrics(
  stats: StatsDetail,
  curve: EquityCurvePoint[],
  period: string,
  positions?: PositionHistoryItem[]
): StatsDetail {
  // From equity curve
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

  // Derive win_rate from equity curve daily returns if not available
  if (stats.profitableTradesPct == null && curve.length >= 5) {
    let wins = 0, total = 0
    for (let i = 1; i < curve.length; i++) {
      const dailyReturn = curve[i].roi - curve[i - 1].roi
      if (dailyReturn > 0.01) wins++
      if (Math.abs(dailyReturn) > 0.01) total++
    }
    if (total >= 3) {
      stats.profitableTradesPct = Math.round((wins / total) * 10000) / 100
    }
  }

  // From position history
  if (positions && positions.length > 0) {
    if (stats.avgHoldingTimeHours == null) {
      stats.avgHoldingTimeHours = calculateAvgHoldingHours(positions)
    }

    // Fill avg profit/loss and largest win/loss from positions
    const { avgProfit, avgLoss, largestWin, largestLoss } = calculateAvgProfitLoss(positions)
    if (stats.avgProfit == null && avgProfit != null) stats.avgProfit = avgProfit
    if (stats.avgLoss == null && avgLoss != null) stats.avgLoss = avgLoss
    if (stats.largestWin == null && largestWin != null) stats.largestWin = largestWin
    if (stats.largestLoss == null && largestLoss != null) stats.largestLoss = largestLoss

    // Fill winning/total positions count
    if (stats.winningPositions == null) {
      const withPnl = positions.filter(p => p.pnlUsd != null)
      if (withPnl.length > 0) {
        stats.winningPositions = withPnl.filter(p => (p.pnlUsd ?? 0) > 0).length
        stats.totalPositions = withPnl.length
      }
    }

    // Fill totalTrades from position count
    if (stats.totalTrades == null && positions.length > 0) {
      stats.totalTrades = positions.length
    }
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
