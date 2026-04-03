/**
 * Derived metrics calculations: volatility, drawdown, sharpe ratio, asset breakdown
 */

import type { EquityCurvePoint, PositionHistoryItem, StatsDetail, AssetBreakdown } from './enrichment-types'

/**
 * Extract the best value series from an equity curve.
 * Prefers ROI (percentage), falls back to PnL (USD) when ROI is all zero/null.
 * Many DEX platforms (Hyperliquid, GMX, Drift) only have PnL in their equity curves.
 */
function extractValues(curve: EquityCurvePoint[]): number[] {
  const roiValues = curve.map(p => p.roi ?? 0)
  const hasRoi = roiValues.some(v => v !== 0)
  if (hasRoi) return roiValues
  // Fallback: use PnL. Values are USD not %, but relative changes still produce
  // valid MDD, Sharpe, and volatility (computed from daily deltas, not absolute scale).
  return curve.map(p => p.pnl ?? 0)
}

/**
 * Calculate daily returns from value series.
 */
function dailyReturns(values: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < values.length; i++) {
    returns.push(values[i] - values[i - 1])
  }
  return returns
}

/**
 * Calculate volatility from equity curve (standard deviation of daily returns)
 */
export function calculateVolatility(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 3) return null

  const returns = dailyReturns(extractValues(curve))
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

  const values = extractValues(curve)
  let peak = values[0]
  for (const v of values) {
    if (v > peak) peak = v
  }

  if (peak <= 0) return null

  const current = values[values.length - 1]
  const drawdown = peak - current
  return drawdown > 0 ? drawdown : 0
}

/**
 * Calculate max drawdown from equity curve
 */
export function calculateMaxDrawdown(curve: EquityCurvePoint[]): number | null {
  if (curve.length < 2) return null

  const values = extractValues(curve)
  let peak = values[0]
  let maxDD = 0

  for (const v of values) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((peak - v) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  return maxDD > 0 ? Math.min(maxDD, 100) : null
}

/**
 * Calculate Sharpe ratio from equity curve (simplified, risk-free rate = 0)
 */
export function calculateSharpeRatio(curve: EquityCurvePoint[], _period: string): number | null {
  if (curve.length < 5) return null

  const returns = dailyReturns(extractValues(curve))
  if (returns.length < 3) return null

  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length
  const stdDev = Math.sqrt(variance)

  if (stdDev === 0) return null

  const annualizationFactor = Math.sqrt(365)
  const sharpe = (meanReturn / stdDev) * annualizationFactor

  return sharpe > -10 && sharpe < 10 ? Math.round(sharpe * 100) / 100 : null
}

/**
 * Calculate Sortino ratio from equity curve (like Sharpe but only penalizes downside volatility)
 */
export function calculateSortinoRatio(curve: EquityCurvePoint[], _period: string): number | null {
  if (curve.length < 5) return null

  const returns = dailyReturns(extractValues(curve))
  if (returns.length < 3) return null

  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const downsideReturns = returns.filter(r => r < 0)
  if (downsideReturns.length === 0) return null // No downside = infinite sortino, skip

  const downsideVariance = downsideReturns.reduce((sum, r) => sum + r * r, 0) / returns.length
  const downsideDev = Math.sqrt(downsideVariance)

  if (downsideDev === 0) return null

  const annualizationFactor = Math.sqrt(365)
  const sortino = (meanReturn / downsideDev) * annualizationFactor

  return sortino > -20 && sortino < 20 ? Math.round(sortino * 100) / 100 : null
}

/**
 * Calculate Calmar ratio from equity curve (annualized return / max drawdown)
 */
export function calculateCalmarRatio(curve: EquityCurvePoint[], _period: string): number | null {
  if (curve.length < 5) return null

  const values = extractValues(curve)
  const totalReturn = values[values.length - 1] - values[0]
  const maxDD = calculateMaxDrawdown(curve)

  if (!maxDD || maxDD === 0) return null

  // Annualize: estimate days from curve length, then scale to 365
  const days = curve.length
  const annualizedReturn = days > 0 ? (totalReturn / days) * 365 : totalReturn

  const calmar = annualizedReturn / maxDD

  return calmar > -50 && calmar < 50 ? Math.round(calmar * 100) / 100 : null
}

/**
 * Calculate Profit Factor from position history (gross profit / gross loss)
 */
export function calculateProfitFactor(positions: PositionHistoryItem[]): number | null {
  const withPnl = positions.filter(p => p.pnlUsd != null)
  if (withPnl.length < 3) return null

  let grossProfit = 0
  let grossLoss = 0
  for (const p of withPnl) {
    const pnl = p.pnlUsd ?? 0
    if (pnl > 0) grossProfit += pnl
    if (pnl < 0) grossLoss += Math.abs(pnl)
  }

  if (grossLoss === 0) return null // Infinite PF, skip

  const pf = grossProfit / grossLoss
  return pf > 0 && pf < 100 ? Math.round(pf * 100) / 100 : null
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

  if (!stats.sharpeRatio && curve.length >= 5) {
    stats.sharpeRatio = calculateSharpeRatio(curve, period)
  }

  if (!stats.sortinoRatio && curve.length >= 5) {
    stats.sortinoRatio = calculateSortinoRatio(curve, period)
  }

  if (!stats.calmarRatio && curve.length >= 5) {
    stats.calmarRatio = calculateCalmarRatio(curve, period)
  }

  // Derive win_rate from equity curve daily returns if not available
  if (stats.profitableTradesPct == null && curve.length >= 5) {
    let wins = 0, total = 0
    const values = extractValues(curve)
    for (let i = 1; i < values.length; i++) {
      const dailyReturn = values[i] - values[i - 1]
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

    // Compute profit factor from positions
    if (!stats.profitFactor) {
      stats.profitFactor = calculateProfitFactor(positions)
    }
  }

  return stats
}

/**
 * Classify trading style based on available metrics.
 * Returns style name + confidence score.
 */
export function classifyTradingStyle(stats: StatsDetail, avgHoldingHours?: number | null): {
  style: string | null
  confidence: number
} {
  const holding = avgHoldingHours ?? stats.avgHoldingTimeHours
  const winRate = stats.profitableTradesPct
  const totalTrades = stats.totalTrades ?? stats.totalPositions
  const mdd = stats.maxDrawdown

  if (holding == null && totalTrades == null) return { style: null, confidence: 0 }

  // Classify by holding time first (most reliable indicator)
  if (holding != null) {
    if (holding < 1) return { style: 'Scalper', confidence: 0.9 }
    if (holding < 8) return { style: 'Day Trader', confidence: 0.85 }
    if (holding < 72) return { style: 'Swing Trader', confidence: 0.8 }
    if (holding < 720) return { style: 'Position Trader', confidence: 0.75 }
    return { style: 'Long-Term', confidence: 0.7 }
  }

  // Fallback: classify by trade frequency (if we have total trades but not holding time)
  if (totalTrades != null && totalTrades > 0) {
    // Estimate daily trades (90D window)
    const dailyTrades = totalTrades / 90
    if (dailyTrades > 20) return { style: 'Scalper', confidence: 0.6 }
    if (dailyTrades > 5) return { style: 'Day Trader', confidence: 0.55 }
    if (dailyTrades > 1) return { style: 'Swing Trader', confidence: 0.5 }
    if (dailyTrades > 0.1) return { style: 'Position Trader', confidence: 0.45 }
    return { style: 'Long-Term', confidence: 0.4 }
  }

  // Last resort: classify by risk profile
  if (winRate != null && mdd != null) {
    if (winRate > 70 && mdd < 10) return { style: 'Conservative', confidence: 0.35 }
    if (winRate < 40 && mdd > 30) return { style: 'Aggressive', confidence: 0.35 }
  }

  return { style: null, confidence: 0 }
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
