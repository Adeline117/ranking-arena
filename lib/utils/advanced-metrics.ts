import { moneySum } from '@/lib/utils/currency'

/**
 * Advanced Trading Metrics Calculations
 *
 * This module provides functions to calculate advanced risk and performance
 * metrics for crypto traders, including:
 * - Sortino Ratio (downside risk-adjusted returns)
 * - Calmar Ratio (annualized ROI / max drawdown)
 * - Profit Factor (gross profit / gross loss)
 * - Recovery Factor (net profit / max drawdown)
 * - Consecutive wins/losses
 * - Volatility metrics
 */

// ============================================
// Types
// ============================================

export interface TradeData {
  pnl: number
  pnlPct: number
  openTime: Date | string
  closeTime: Date | string
  symbol?: string
  side?: 'long' | 'short'
}

export interface PositionData {
  openTime: Date | string
  closeTime: Date | string
  holdingHours?: number
}

export interface DailyReturn {
  date: Date | string
  returnPct: number
}

export interface ConsecutiveStats {
  maxWins: number
  maxLosses: number
  currentWinStreak: number
  currentLossStreak: number
}

export interface VolatilityMetrics {
  volatility: number | null
  downsideVolatility: number | null
  annualizedVolatility: number | null
}

// ============================================
// Constants
// ============================================

const TRADING_DAYS_PER_YEAR = 365 // Crypto markets are 24/7
const MIN_DATA_POINTS = 7 // Minimum data points for statistical calculations

// ============================================
// Core Calculation Functions
// ============================================

/**
 * Calculate Sortino Ratio
 *
 * Sortino Ratio = (Portfolio Return - Risk Free Rate) / Downside Deviation
 *
 * Unlike Sharpe ratio, Sortino only considers downside volatility,
 * making it more appropriate for asymmetric return distributions.
 *
 * @param returns Array of period returns (as percentages, e.g., 5 for 5%)
 * @param riskFreeRate Annual risk-free rate (default 0 for crypto)
 * @param annualize Whether to annualize the ratio (default true)
 * @returns Sortino ratio or null if insufficient data
 */
export function calculateSortinoRatio(
  returns: number[],
  riskFreeRate: number = 0,
  annualize: boolean = true
): number | null {
  if (!returns || returns.length < MIN_DATA_POINTS) return null

  // Convert to decimals
  const decimalReturns = returns.map((r) => r / 100)
  const rfDaily = riskFreeRate / TRADING_DAYS_PER_YEAR / 100

  // Calculate average excess return
  const excessReturns = decimalReturns.map((r) => r - rfDaily)
  const avgExcessReturn = excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length

  // Calculate downside deviation (only negative returns)
  const negativeReturns = excessReturns.filter((r) => r < 0)
  if (negativeReturns.length === 0) {
    // No negative returns = infinite Sortino, cap at reasonable value
    return 10
  }

  const sumSquaredNegative = negativeReturns.reduce((sum, r) => sum + r * r, 0)
  const downsideDeviation = Math.sqrt(sumSquaredNegative / excessReturns.length)

  if (downsideDeviation === 0) return 10

  let sortino = avgExcessReturn / downsideDeviation

  if (annualize) {
    sortino *= Math.sqrt(TRADING_DAYS_PER_YEAR)
  }

  // Cap at reasonable bounds
  return Math.max(-10, Math.min(10, sortino))
}

/**
 * Calculate Calmar Ratio
 *
 * Calmar Ratio = Annualized ROI / |Max Drawdown|
 *
 * Measures return relative to the worst-case scenario (max drawdown).
 * Higher values indicate better risk-adjusted performance.
 *
 * @param roi Total ROI for the period (as percentage, e.g., 50 for 50%)
 * @param maxDrawdown Maximum drawdown (as percentage, e.g., 20 for 20%)
 * @param periodDays Number of days in the period
 * @returns Calmar ratio or null if invalid inputs
 */
export function calculateCalmarRatio(
  roi: number,
  maxDrawdown: number,
  periodDays: number
): number | null {
  if (roi === null || roi === undefined) return null
  if (!maxDrawdown || maxDrawdown === 0) return null
  if (periodDays <= 0) return null

  // Annualize the ROI
  const annualizationFactor = TRADING_DAYS_PER_YEAR / periodDays
  const annualizedRoi = roi * annualizationFactor

  // Max drawdown should be positive for division
  const absDrawdown = Math.abs(maxDrawdown)

  const calmar = annualizedRoi / absDrawdown

  // Cap at reasonable bounds
  return Math.max(-10, Math.min(10, calmar))
}

/**
 * Calculate Profit Factor
 *
 * Profit Factor = Gross Profit / |Gross Loss|
 *
 * A profit factor > 1 indicates profitable trading.
 * - < 1.0: Losing strategy
 * - 1.0 - 1.5: Marginal
 * - 1.5 - 2.0: Good
 * - > 2.0: Excellent
 *
 * @param trades Array of trade data with PnL
 * @returns Profit factor or null if no losing trades
 */
export function calculateProfitFactor(trades: TradeData[]): number | null {
  if (!trades || trades.length === 0) return null

  const grossProfit = moneySum(trades.filter((t) => t.pnl > 0).map((t) => t.pnl))

  const grossLoss = Math.abs(moneySum(trades.filter((t) => t.pnl < 0).map((t) => t.pnl)))

  if (grossLoss === 0) {
    // No losses = infinite profit factor, cap at 10
    return grossProfit > 0 ? 10 : null
  }

  const profitFactor = grossProfit / grossLoss

  // Cap at reasonable bounds
  return Math.min(10, profitFactor)
}

/**
 * Calculate Recovery Factor
 *
 * Recovery Factor = Net Profit / |Max Drawdown|
 *
 * Indicates how many times the net profit exceeds the worst drawdown.
 * Higher values suggest the strategy can recover from drawdowns.
 *
 * @param netProfit Total net profit (in USD)
 * @param maxDrawdown Maximum drawdown (as percentage or absolute value)
 * @param initialCapital Initial capital for percentage-based drawdown conversion
 * @returns Recovery factor or null if invalid
 */
export function calculateRecoveryFactor(
  netProfit: number,
  maxDrawdown: number,
  initialCapital?: number
): number | null {
  if (netProfit === null || netProfit === undefined) return null
  if (!maxDrawdown || maxDrawdown === 0) return null

  // If maxDrawdown is a percentage and we have initial capital, convert
  let absDrawdown = Math.abs(maxDrawdown)
  if (absDrawdown <= 100 && initialCapital) {
    absDrawdown = (absDrawdown / 100) * initialCapital
  }

  if (absDrawdown === 0) return null

  const recoveryFactor = netProfit / absDrawdown

  // Cap at reasonable bounds
  return Math.max(-10, Math.min(10, recoveryFactor))
}

/**
 * Calculate Maximum Consecutive Wins and Losses
 *
 * @param trades Array of trade data (must be chronologically sorted)
 * @returns Stats including max consecutive wins/losses and current streaks
 */
export function calculateConsecutiveStats(trades: TradeData[]): ConsecutiveStats {
  if (!trades || trades.length === 0) {
    return { maxWins: 0, maxLosses: 0, currentWinStreak: 0, currentLossStreak: 0 }
  }

  let maxWins = 0
  let maxLosses = 0
  let currentWins = 0
  let currentLosses = 0

  for (const trade of trades) {
    if (trade.pnl > 0) {
      currentWins++
      currentLosses = 0
      maxWins = Math.max(maxWins, currentWins)
    } else if (trade.pnl < 0) {
      currentLosses++
      currentWins = 0
      maxLosses = Math.max(maxLosses, currentLosses)
    }
    // Breakeven trades don't affect streaks
  }

  return {
    maxWins,
    maxLosses,
    currentWinStreak: currentWins,
    currentLossStreak: currentLosses,
  }
}

/**
 * Calculate Average Holding Time
 *
 * @param positions Array of position data with open/close times
 * @returns Average holding time in hours, or null if no data
 */
export function calculateAvgHoldingTime(positions: PositionData[]): number | null {
  if (!positions || positions.length === 0) return null

  const holdingTimes = positions.map((p) => {
    if (p.holdingHours !== undefined) return p.holdingHours

    const openTime = new Date(p.openTime).getTime()
    const closeTime = new Date(p.closeTime).getTime()
    return (closeTime - openTime) / (1000 * 60 * 60) // Convert ms to hours
  })

  const validTimes = holdingTimes.filter((t) => t > 0 && isFinite(t))
  if (validTimes.length === 0) return null

  const avgHours = validTimes.reduce((a, b) => a + b, 0) / validTimes.length

  // Cap at reasonable maximum (1 year in hours)
  return Math.min(avgHours, 8760)
}

/**
 * Calculate Volatility (Standard Deviation of Returns)
 *
 * @param returns Array of period returns (as percentages)
 * @param annualize Whether to annualize (default true)
 * @returns Volatility as percentage, or null if insufficient data
 */
export function calculateVolatility(returns: number[], annualize: boolean = true): number | null {
  if (!returns || returns.length < MIN_DATA_POINTS) return null

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const squaredDiffs = returns.map((r) => Math.pow(r - mean, 2))
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / returns.length
  let stdDev = Math.sqrt(variance)

  if (annualize) {
    stdDev *= Math.sqrt(TRADING_DAYS_PER_YEAR)
  }

  return stdDev
}

/**
 * Calculate Downside Volatility
 *
 * Only considers returns below a threshold (typically 0).
 *
 * @param returns Array of period returns (as percentages)
 * @param threshold Threshold below which returns are considered downside (default 0)
 * @param annualize Whether to annualize (default true)
 * @returns Downside volatility as percentage, or null if insufficient data
 */
export function calculateDownsideVolatility(
  returns: number[],
  threshold: number = 0,
  annualize: boolean = true
): number | null {
  if (!returns || returns.length < MIN_DATA_POINTS) return null

  const downsideReturns = returns.filter((r) => r < threshold)
  if (downsideReturns.length === 0) return 0

  const squaredDownside = downsideReturns.map((r) => Math.pow(r - threshold, 2))
  const downsideVariance = squaredDownside.reduce((a, b) => a + b, 0) / returns.length
  let downsideStdDev = Math.sqrt(downsideVariance)

  if (annualize) {
    downsideStdDev *= Math.sqrt(TRADING_DAYS_PER_YEAR)
  }

  return downsideStdDev
}

/**
 * Calculate all volatility metrics at once
 *
 * @param returns Array of period returns (as percentages)
 * @returns Object with volatility, downside volatility, and annualized volatility
 */
export function calculateVolatilityMetrics(returns: number[]): VolatilityMetrics {
  return {
    volatility: calculateVolatility(returns, false),
    downsideVolatility: calculateDownsideVolatility(returns, 0, false),
    annualizedVolatility: calculateVolatility(returns, true),
  }
}

// ============================================
// Batch Calculation Helpers
// ============================================

export interface AdvancedMetricsInput {
  dailyReturns: number[]
  trades: TradeData[]
  positions: PositionData[]
  roi: number
  pnl: number
  maxDrawdown: number
  periodDays: number
  initialCapital?: number
}

export interface AdvancedMetricsResult {
  sortinoRatio: number | null
  calmarRatio: number | null
  profitFactor: number | null
  recoveryFactor: number | null
  maxConsecutiveWins: number | null
  maxConsecutiveLosses: number | null
  avgHoldingHours: number | null
  volatilityPct: number | null
  downsideVolatilityPct: number | null
}

/**
 * Calculate all advanced metrics at once
 *
 * @param input All required data for calculations
 * @returns Object containing all advanced metrics
 */
export function calculateAdvancedMetrics(input: AdvancedMetricsInput): AdvancedMetricsResult {
  const {
    dailyReturns,
    trades,
    positions,
    roi,
    pnl,
    maxDrawdown,
    periodDays,
    initialCapital,
  } = input

  const consecutiveStats = calculateConsecutiveStats(trades)
  const volatilityMetrics = calculateVolatilityMetrics(dailyReturns)

  return {
    sortinoRatio: calculateSortinoRatio(dailyReturns),
    calmarRatio: calculateCalmarRatio(roi, maxDrawdown, periodDays),
    profitFactor: calculateProfitFactor(trades),
    recoveryFactor: calculateRecoveryFactor(pnl, maxDrawdown, initialCapital),
    maxConsecutiveWins: consecutiveStats.maxWins,
    maxConsecutiveLosses: consecutiveStats.maxLosses,
    avgHoldingHours: calculateAvgHoldingTime(positions),
    volatilityPct: volatilityMetrics.volatility,
    downsideVolatilityPct: volatilityMetrics.downsideVolatility,
  }
}
