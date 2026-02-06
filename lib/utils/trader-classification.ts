/**
 * Trader Classification Module
 *
 * Classifies traders into trading styles based on their behavior patterns:
 * - HFT (High-Frequency Trading): Very short holding times, many trades
 * - Day Trader: Intraday positions, multiple trades per day
 * - Swing Trader: Multi-day to multi-week positions
 * - Trend Follower: Long-term positions following market trends
 * - Scalping: Quick trades for small profits
 *
 * Also detects asset preferences (BTC, ETH, altcoins, etc.)
 */

// ============================================
// Types
// ============================================

export type TradingStyle = 'hft' | 'day_trader' | 'swing' | 'trend' | 'scalping'

export interface TradeData {
  symbol: string
  side: 'long' | 'short'
  pnl: number
  pnlPct: number
  openTime: Date | string
  closeTime: Date | string
  holdingHours?: number
  leverage?: number
}

export interface TraderFeatures {
  avgHoldingHours: number
  tradesPerDay: number
  avgLeverage: number
  winRate: number
  avgPnlPct: number
  profitFactor: number
  uniqueSymbols: number
  longShortRatio: number // > 1 = more longs, < 1 = more shorts
}

export interface StyleClassification {
  style: TradingStyle
  confidence: number
  scores: Record<TradingStyle, number>
  reasoning: string[]
}

export interface AssetPreference {
  preference: string[]
  weights: Record<string, number>
  concentration: number // 0-1, higher = more concentrated
}

// ============================================
// Constants & Thresholds
// ============================================

const STYLE_THRESHOLDS = {
  hft: {
    maxAvgHoldingHours: 0.5, // 30 minutes
    minTradesPerDay: 20,
  },
  scalping: {
    maxAvgHoldingHours: 2, // 2 hours
    minTradesPerDay: 5,
  },
  day_trader: {
    maxAvgHoldingHours: 24, // Same day
    minTradesPerDay: 1,
  },
  swing: {
    minAvgHoldingHours: 24,
    maxAvgHoldingHours: 168, // 1 week
  },
  trend: {
    minAvgHoldingHours: 168, // More than 1 week
  },
}

// Asset categorization
const ASSET_CATEGORIES = {
  btc: ['BTC', 'BTCUSDT', 'BTCUSD', 'BTCPERP', 'XBTUSD'],
  eth: ['ETH', 'ETHUSDT', 'ETHUSD', 'ETHPERP'],
  altcoins: ['SOL', 'DOGE', 'XRP', 'ADA', 'AVAX', 'DOT', 'MATIC', 'LINK', 'ATOM'],
  memecoins: ['DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI'],
  defi: ['UNI', 'AAVE', 'MKR', 'SNX', 'COMP', 'CRV', 'SUSHI'],
}

// ============================================
// Feature Extraction
// ============================================

/**
 * Extract features from trade history for classification
 */
export function extractTraderFeatures(trades: TradeData[]): TraderFeatures | null {
  if (!trades || trades.length === 0) return null

  // Calculate holding times
  const holdingHours = trades.map((t) => {
    if (t.holdingHours !== undefined) return t.holdingHours
    const open = new Date(t.openTime).getTime()
    const close = new Date(t.closeTime).getTime()
    return (close - open) / (1000 * 60 * 60)
  })

  const validHoldingHours = holdingHours.filter((h) => h > 0 && isFinite(h))
  const avgHoldingHours =
    validHoldingHours.length > 0
      ? validHoldingHours.reduce((a, b) => a + b, 0) / validHoldingHours.length
      : 24 // Default to day trader if no data

  // Calculate trading frequency
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime()
  )
  const firstTrade = new Date(sortedTrades[0].openTime)
  const lastTrade = new Date(sortedTrades[sortedTrades.length - 1].closeTime)
  const tradingDays = Math.max(1, (lastTrade.getTime() - firstTrade.getTime()) / (1000 * 60 * 60 * 24))
  const tradesPerDay = trades.length / tradingDays

  // Calculate leverage stats
  const leverages = trades.map((t) => t.leverage || 1).filter((l) => l > 0)
  const avgLeverage = leverages.reduce((a, b) => a + b, 0) / leverages.length || 1

  // Calculate win rate
  const wins = trades.filter((t) => t.pnl > 0).length
  const winRate = (wins / trades.length) * 100

  // Calculate avg PnL percentage
  const pnlPcts = trades.map((t) => t.pnlPct).filter((p) => isFinite(p))
  const avgPnlPct = pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length || 0

  // Calculate profit factor
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0

  // Count unique symbols
  const symbols = new Set(trades.map((t) => t.symbol))
  const uniqueSymbols = symbols.size

  // Calculate long/short ratio
  const longs = trades.filter((t) => t.side === 'long').length
  const shorts = trades.filter((t) => t.side === 'short').length
  const longShortRatio = shorts > 0 ? longs / shorts : longs > 0 ? 10 : 1

  return {
    avgHoldingHours,
    tradesPerDay,
    avgLeverage,
    winRate,
    avgPnlPct,
    profitFactor,
    uniqueSymbols,
    longShortRatio,
  }
}

// ============================================
// Style Classification
// ============================================

/**
 * Calculate style scores based on features
 */
function calculateStyleScores(features: TraderFeatures): Record<TradingStyle, number> {
  const scores: Record<TradingStyle, number> = {
    hft: 0,
    scalping: 0,
    day_trader: 0,
    swing: 0,
    trend: 0,
  }

  const { avgHoldingHours, tradesPerDay, avgLeverage, profitFactor } = features

  // HFT: Very short holding, very high frequency
  if (avgHoldingHours <= STYLE_THRESHOLDS.hft.maxAvgHoldingHours) {
    scores.hft += 40
  }
  if (tradesPerDay >= STYLE_THRESHOLDS.hft.minTradesPerDay) {
    scores.hft += 40
  }
  if (avgLeverage > 10) {
    scores.hft += 10
  }
  scores.hft += Math.min(10, tradesPerDay / 5) // Bonus for high frequency

  // Scalping: Short holding, high frequency
  if (
    avgHoldingHours <= STYLE_THRESHOLDS.scalping.maxAvgHoldingHours &&
    avgHoldingHours > STYLE_THRESHOLDS.hft.maxAvgHoldingHours
  ) {
    scores.scalping += 35
  }
  if (
    tradesPerDay >= STYLE_THRESHOLDS.scalping.minTradesPerDay &&
    tradesPerDay < STYLE_THRESHOLDS.hft.minTradesPerDay
  ) {
    scores.scalping += 35
  }
  if (avgLeverage > 5) {
    scores.scalping += 15
  }
  if (profitFactor > 1.2 && profitFactor < 2) {
    scores.scalping += 15 // Scalpers typically have moderate profit factors
  }

  // Day Trader: Intraday positions
  if (
    avgHoldingHours <= STYLE_THRESHOLDS.day_trader.maxAvgHoldingHours &&
    avgHoldingHours > STYLE_THRESHOLDS.scalping.maxAvgHoldingHours
  ) {
    scores.day_trader += 40
  }
  if (
    tradesPerDay >= STYLE_THRESHOLDS.day_trader.minTradesPerDay &&
    tradesPerDay < STYLE_THRESHOLDS.scalping.minTradesPerDay
  ) {
    scores.day_trader += 30
  }
  if (avgLeverage > 2 && avgLeverage <= 10) {
    scores.day_trader += 15
  }
  scores.day_trader += Math.min(15, features.uniqueSymbols * 2) // Day traders often trade multiple assets

  // Swing Trader: Multi-day positions
  if (
    avgHoldingHours >= STYLE_THRESHOLDS.swing.minAvgHoldingHours &&
    avgHoldingHours <= STYLE_THRESHOLDS.swing.maxAvgHoldingHours
  ) {
    scores.swing += 45
  }
  if (tradesPerDay < 1 && tradesPerDay > 0.1) {
    scores.swing += 30 // Few trades per day but not inactive
  }
  if (avgLeverage <= 5) {
    scores.swing += 15
  }
  if (profitFactor > 2) {
    scores.swing += 10 // Swing traders aim for bigger moves
  }

  // Trend Follower: Long-term positions
  if (avgHoldingHours >= STYLE_THRESHOLDS.trend.minAvgHoldingHours) {
    scores.trend += 50
  }
  if (tradesPerDay <= 0.1) {
    scores.trend += 25 // Very few trades
  }
  if (avgLeverage <= 3) {
    scores.trend += 15
  }
  if (profitFactor > 2.5) {
    scores.trend += 10 // Trend followers aim for big wins
  }

  return scores
}

/**
 * Classify trader's trading style
 */
export function classifyTradingStyle(features: TraderFeatures): StyleClassification {
  const scores = calculateStyleScores(features)

  // Find the highest scoring style
  let maxScore = 0
  let style: TradingStyle = 'day_trader'

  for (const [s, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score
      style = s as TradingStyle
    }
  }

  // Calculate confidence (normalize scores)
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0)
  const confidence = totalScore > 0 ? (maxScore / totalScore) * 100 : 0

  // Generate reasoning
  const reasoning: string[] = []
  if (features.avgHoldingHours < 1) {
    reasoning.push(`Very short avg holding time (${features.avgHoldingHours.toFixed(1)}h)`)
  } else if (features.avgHoldingHours < 24) {
    reasoning.push(`Intraday positions (avg ${features.avgHoldingHours.toFixed(1)}h)`)
  } else if (features.avgHoldingHours < 168) {
    reasoning.push(`Multi-day positions (avg ${(features.avgHoldingHours / 24).toFixed(1)} days)`)
  } else {
    reasoning.push(`Long-term positions (avg ${(features.avgHoldingHours / 168).toFixed(1)} weeks)`)
  }

  if (features.tradesPerDay >= 10) {
    reasoning.push(`High trading frequency (${features.tradesPerDay.toFixed(1)} trades/day)`)
  } else if (features.tradesPerDay >= 1) {
    reasoning.push(`Active trading (${features.tradesPerDay.toFixed(1)} trades/day)`)
  } else {
    reasoning.push(`Selective trading (${(features.tradesPerDay * 7).toFixed(1)} trades/week)`)
  }

  return {
    style,
    confidence: Math.round(confidence),
    scores,
    reasoning,
  }
}

// ============================================
// Asset Preference Detection
// ============================================

/**
 * Categorize a symbol into asset categories
 */
function categorizeSymbol(symbol: string): string {
  const upperSymbol = symbol.toUpperCase()

  for (const [category, symbols] of Object.entries(ASSET_CATEGORIES)) {
    if (symbols.some((s) => upperSymbol.includes(s))) {
      return category
    }
  }

  return 'other'
}

/**
 * Detect trader's asset preferences
 */
export function detectAssetPreference(trades: TradeData[]): AssetPreference {
  if (!trades || trades.length === 0) {
    return { preference: [], weights: {}, concentration: 0 }
  }

  // Count trades by symbol
  const symbolCounts: Record<string, number> = {}
  const categoryCounts: Record<string, number> = {}

  for (const trade of trades) {
    const symbol = trade.symbol.toUpperCase()
    symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1

    const category = categorizeSymbol(symbol)
    categoryCounts[category] = (categoryCounts[category] || 0) + 1
  }

  // Calculate weights
  const total = trades.length
  const weights: Record<string, number> = {}

  for (const [symbol, count] of Object.entries(symbolCounts)) {
    weights[symbol] = Math.round((count / total) * 100)
  }

  // Sort by weight and get top preferences
  const sortedSymbols = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([symbol]) => symbol)

  // Calculate concentration (Herfindahl index)
  const proportions = Object.values(symbolCounts).map((c) => c / total)
  const herfindahl = proportions.reduce((sum, p) => sum + p * p, 0)
  const concentration = Math.min(1, herfindahl * 2) // Normalize

  return {
    preference: sortedSymbols,
    weights,
    concentration,
  }
}

// ============================================
// Combined Classification
// ============================================

export interface TraderClassificationResult {
  style: StyleClassification
  assetPreference: AssetPreference
  features: TraderFeatures
}

/**
 * Full trader classification including style and asset preference
 */
export function classifyTrader(trades: TradeData[]): TraderClassificationResult | null {
  const features = extractTraderFeatures(trades)
  if (!features) return null

  const style = classifyTradingStyle(features)
  const assetPreference = detectAssetPreference(trades)

  return {
    style,
    assetPreference,
    features,
  }
}
