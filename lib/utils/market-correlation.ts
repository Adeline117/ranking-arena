/**
 * Market Correlation Calculations
 *
 * This module provides functions to calculate market correlation metrics:
 * - Beta (correlation with BTC/ETH)
 * - Alpha (Jensen's Alpha - excess returns)
 * - Market condition detection
 */

// ============================================
// Types
// ============================================

export interface DailyReturn {
  date: Date | string
  returnPct: number
}

export type MarketCondition = 'bull' | 'bear' | 'sideways'

export type VolatilityRegime = 'low' | 'medium' | 'high' | 'extreme'

export interface MarketConditionPerformance {
  bull: number | null
  bear: number | null
  sideways: number | null
}

export interface CorrelationResult {
  correlation: number
  beta: number
  rSquared: number
}

export interface MarketConditionAnalysis {
  condition: MarketCondition
  volatilityRegime: VolatilityRegime
  trendStrength: number
  confidence: number
}

// ============================================
// Constants
// ============================================

const MIN_DATA_POINTS = 14 // Minimum 2 weeks of daily data
const BULL_THRESHOLD = 0.05 // 5% gain = bull market
const BEAR_THRESHOLD = -0.05 // 5% loss = bear market
const HIGH_VOLATILITY_THRESHOLD = 50 // 50% annualized volatility
const EXTREME_VOLATILITY_THRESHOLD = 100 // 100% annualized volatility
const RISK_FREE_RATE = 0.05 // 5% annual risk-free rate (can be adjusted)
const TRADING_DAYS_PER_YEAR = 365

// ============================================
// Statistical Helper Functions
// ============================================

/**
 * Calculate the mean of an array of numbers
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * Calculate standard deviation
 */
function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const avg = mean(values)
  const squaredDiffs = values.map((v) => Math.pow(v - avg, 2))
  return Math.sqrt(mean(squaredDiffs))
}

/**
 * Calculate covariance between two arrays
 */
function covariance(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0
  const xMean = mean(x)
  const yMean = mean(y)
  const products = x.map((xi, i) => (xi - xMean) * (y[i] - yMean))
  return mean(products)
}

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return 0
  const xStd = standardDeviation(x)
  const yStd = standardDeviation(y)
  if (xStd === 0 || yStd === 0) return 0
  return covariance(x, y) / (xStd * yStd)
}

// ============================================
// Core Calculation Functions
// ============================================

/**
 * Calculate Beta (market sensitivity coefficient)
 *
 * Beta = Covariance(Trader Returns, Benchmark Returns) / Variance(Benchmark Returns)
 *
 * Interpretation:
 * - Beta = 1: Moves exactly with the market
 * - Beta > 1: More volatile than market (amplifies movements)
 * - Beta < 1: Less volatile than market (dampens movements)
 * - Beta < 0: Moves opposite to market
 *
 * @param traderReturns Array of trader's daily returns (as percentages)
 * @param benchmarkReturns Array of benchmark daily returns (as percentages, e.g., BTC)
 * @returns Beta coefficient or null if insufficient data
 */
export function calculateBeta(
  traderReturns: number[],
  benchmarkReturns: number[]
): number | null {
  if (
    !traderReturns ||
    !benchmarkReturns ||
    traderReturns.length < MIN_DATA_POINTS ||
    benchmarkReturns.length < MIN_DATA_POINTS
  ) {
    return null
  }

  // Ensure arrays are same length (use shorter)
  const length = Math.min(traderReturns.length, benchmarkReturns.length)
  const tReturns = traderReturns.slice(-length)
  const bReturns = benchmarkReturns.slice(-length)

  // Convert percentages to decimals
  const tDecimal = tReturns.map((r) => r / 100)
  const bDecimal = bReturns.map((r) => r / 100)

  // Calculate variance of benchmark
  const benchmarkVariance = standardDeviation(bDecimal) ** 2
  if (benchmarkVariance === 0) return null

  // Calculate covariance
  const cov = covariance(tDecimal, bDecimal)

  // Beta = Cov(r_i, r_m) / Var(r_m)
  const beta = cov / benchmarkVariance

  // Cap at reasonable bounds
  return Math.max(-5, Math.min(5, beta))
}

/**
 * Calculate correlation metrics including beta and R-squared
 *
 * @param traderReturns Array of trader's daily returns
 * @param benchmarkReturns Array of benchmark daily returns
 * @returns Correlation result with beta, correlation, and R-squared
 */
export function calculateCorrelationMetrics(
  traderReturns: number[],
  benchmarkReturns: number[]
): CorrelationResult | null {
  if (
    !traderReturns ||
    !benchmarkReturns ||
    traderReturns.length < MIN_DATA_POINTS ||
    benchmarkReturns.length < MIN_DATA_POINTS
  ) {
    return null
  }

  const length = Math.min(traderReturns.length, benchmarkReturns.length)
  const tReturns = traderReturns.slice(-length)
  const bReturns = benchmarkReturns.slice(-length)

  const correlation = pearsonCorrelation(tReturns, bReturns)
  const beta = calculateBeta(tReturns, bReturns)

  if (beta === null) return null

  return {
    correlation,
    beta,
    rSquared: correlation ** 2,
  }
}

/**
 * Calculate Alpha (Jensen's Alpha)
 *
 * Alpha = Portfolio Return - [Risk-Free Rate + Beta * (Benchmark Return - Risk-Free Rate)]
 *
 * Alpha measures the excess return not explained by market movements.
 * Positive alpha = outperforming risk-adjusted expectations.
 *
 * @param traderReturn Total trader return for period (as percentage)
 * @param benchmarkReturn Total benchmark return for period (as percentage)
 * @param beta Pre-calculated beta coefficient
 * @param periodDays Number of days in the period (for annualization)
 * @param riskFreeRate Annual risk-free rate (default 5%)
 * @returns Alpha or null if invalid inputs
 */
export function calculateAlpha(
  traderReturn: number,
  benchmarkReturn: number,
  beta: number,
  periodDays: number = 30,
  riskFreeRate: number = RISK_FREE_RATE
): number | null {
  if (traderReturn === null || traderReturn === undefined) return null
  if (benchmarkReturn === null || benchmarkReturn === undefined) return null
  if (beta === null || beta === undefined) return null
  if (periodDays <= 0) return null

  // Convert to period-specific risk-free rate
  const periodRf = (riskFreeRate / TRADING_DAYS_PER_YEAR) * periodDays * 100 // As percentage

  // Convert returns to decimals
  const tReturn = traderReturn / 100
  const bReturn = benchmarkReturn / 100
  const rfReturn = periodRf / 100

  // Calculate expected return based on CAPM
  const expectedReturn = rfReturn + beta * (bReturn - rfReturn)

  // Alpha = Actual - Expected
  const alpha = (tReturn - expectedReturn) * 100 // Convert back to percentage

  // Cap at reasonable bounds
  return Math.max(-100, Math.min(100, alpha))
}

/**
 * Detect current market condition based on recent returns
 *
 * @param returns Array of daily returns (as percentages)
 * @param lookbackDays Number of days to analyze (default 30)
 * @returns Market condition ('bull', 'bear', or 'sideways')
 */
export function detectMarketCondition(
  returns: number[],
  lookbackDays: number = 30
): MarketCondition {
  if (!returns || returns.length === 0) return 'sideways'

  const recentReturns = returns.slice(-lookbackDays)
  if (recentReturns.length === 0) return 'sideways'

  // Calculate cumulative return
  const cumulative = recentReturns.reduce((acc, r) => acc * (1 + r / 100), 1) - 1

  if (cumulative >= BULL_THRESHOLD) return 'bull'
  if (cumulative <= BEAR_THRESHOLD) return 'bear'
  return 'sideways'
}

/**
 * Detect volatility regime
 *
 * @param returns Array of daily returns (as percentages)
 * @returns Volatility regime classification
 */
export function detectVolatilityRegime(returns: number[]): VolatilityRegime {
  if (!returns || returns.length < MIN_DATA_POINTS) return 'medium'

  const stdDev = standardDeviation(returns)
  const annualizedVol = stdDev * Math.sqrt(TRADING_DAYS_PER_YEAR)

  if (annualizedVol >= EXTREME_VOLATILITY_THRESHOLD) return 'extreme'
  if (annualizedVol >= HIGH_VOLATILITY_THRESHOLD) return 'high'
  if (annualizedVol >= 20) return 'medium'
  return 'low'
}

/**
 * Calculate trend strength using simple moving average comparison
 *
 * @param returns Array of daily returns
 * @param shortPeriod Short SMA period (default 7)
 * @param longPeriod Long SMA period (default 30)
 * @returns Trend strength from -1 (strong downtrend) to 1 (strong uptrend)
 */
export function calculateTrendStrength(
  returns: number[],
  shortPeriod: number = 7,
  longPeriod: number = 30
): number {
  if (!returns || returns.length < longPeriod) return 0

  // Convert returns to cumulative values for SMA calculation
  const prices: number[] = [100]
  for (const r of returns) {
    prices.push(prices[prices.length - 1] * (1 + r / 100))
  }

  const recentPrices = prices.slice(-longPeriod - 1)

  // Calculate SMAs
  const shortSMA = mean(recentPrices.slice(-shortPeriod))
  const longSMA = mean(recentPrices)

  if (longSMA === 0) return 0

  // Trend strength = (Short SMA - Long SMA) / Long SMA, normalized
  const strength = (shortSMA - longSMA) / longSMA
  return Math.max(-1, Math.min(1, strength * 10)) // Scale and cap
}

/**
 * Comprehensive market condition analysis
 *
 * @param returns Array of daily returns
 * @returns Full market condition analysis
 */
export function analyzeMarketCondition(returns: number[]): MarketConditionAnalysis {
  const condition = detectMarketCondition(returns)
  const volatilityRegime = detectVolatilityRegime(returns)
  const trendStrength = calculateTrendStrength(returns)

  // Calculate confidence based on data quality and consistency
  const dataPoints = returns?.length || 0
  const dataConfidence = Math.min(1, dataPoints / 90) // Full confidence at 90 days
  const trendConsistency = Math.abs(trendStrength) // Higher = more confident

  const confidence = (dataConfidence * 0.6 + trendConsistency * 0.4) * 100

  return {
    condition,
    volatilityRegime,
    trendStrength,
    confidence: Math.round(confidence),
  }
}

/**
 * Calculate trader's performance by market condition
 *
 * @param traderReturns Array of trader's daily returns
 * @param benchmarkReturns Array of benchmark daily returns (to determine conditions)
 * @returns Performance breakdown by market condition
 */
export function calculateMarketConditionPerformance(
  traderReturns: number[],
  benchmarkReturns: number[]
): MarketConditionPerformance {
  if (
    !traderReturns ||
    !benchmarkReturns ||
    traderReturns.length !== benchmarkReturns.length
  ) {
    return { bull: null, bear: null, sideways: null }
  }

  const bullReturns: number[] = []
  const bearReturns: number[] = []
  const sidewaysReturns: number[] = []

  // Use 7-day lookback for condition detection
  const lookback = 7

  for (let i = lookback; i < benchmarkReturns.length; i++) {
    const recentBenchmark = benchmarkReturns.slice(i - lookback, i)
    const condition = detectMarketCondition(recentBenchmark, lookback)

    switch (condition) {
      case 'bull':
        bullReturns.push(traderReturns[i])
        break
      case 'bear':
        bearReturns.push(traderReturns[i])
        break
      default:
        sidewaysReturns.push(traderReturns[i])
    }
  }

  // Calculate cumulative returns for each condition
  const calcCumulative = (returns: number[]): number | null => {
    if (returns.length === 0) return null
    return (returns.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100
  }

  return {
    bull: calcCumulative(bullReturns),
    bear: calcCumulative(bearReturns),
    sideways: calcCumulative(sidewaysReturns),
  }
}

// ============================================
// Batch Calculation Helpers
// ============================================

export interface MarketCorrelationInput {
  traderReturns: number[]
  btcReturns: number[]
  ethReturns: number[]
  traderTotalReturn: number
  btcTotalReturn: number
  periodDays: number
}

export interface MarketCorrelationResult {
  betaBtc: number | null
  betaEth: number | null
  alpha: number | null
  marketCondition: MarketCondition
  volatilityRegime: VolatilityRegime
  marketConditionPerformance: MarketConditionPerformance
}

/**
 * Calculate all market correlation metrics at once
 */
export function calculateMarketCorrelation(
  input: MarketCorrelationInput
): MarketCorrelationResult {
  const {
    traderReturns,
    btcReturns,
    ethReturns,
    traderTotalReturn,
    btcTotalReturn,
    periodDays,
  } = input

  const betaBtc = calculateBeta(traderReturns, btcReturns)
  const betaEth = calculateBeta(traderReturns, ethReturns)
  const alpha = betaBtc !== null
    ? calculateAlpha(traderTotalReturn, btcTotalReturn, betaBtc, periodDays)
    : null

  const marketAnalysis = analyzeMarketCondition(btcReturns)
  const conditionPerformance = calculateMarketConditionPerformance(traderReturns, btcReturns)

  return {
    betaBtc,
    betaEth,
    alpha,
    marketCondition: marketAnalysis.condition,
    volatilityRegime: marketAnalysis.volatilityRegime,
    marketConditionPerformance: conditionPerformance,
  }
}
