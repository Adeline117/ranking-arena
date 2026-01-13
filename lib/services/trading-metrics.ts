/**
 * 交易数据计算服务
 * 实现所有 account_required_* 字段的计算逻辑
 */

export interface Trade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  fee: number
  pnl?: number
  executed_at: string
  holding_time_days?: number
}

export interface TradeLevelStats {
  total_trades: number
  avg_profit: number
  avg_loss: number
  profitable_trades_pct: number
}

export interface DetailedMetrics {
  avg_pnl: number
  max_drawdown: number
  sharpe_ratio: number
  sortino_ratio: number
}

export interface HoldingTimeAnalysis {
  avg_holding_time: number
  median_holding_time: number
  short_term_trades_pct: number
  long_term_trades_pct: number
}

export interface ProfitabilityAnalysis {
  profitable_trades_count: number
  losing_trades_count: number
  largest_win: number
  largest_loss: number
  win_loss_ratio: number
}

export interface RiskMetrics {
  volatility: number
  beta: number
  var_95: number
  max_leverage: number
}

export interface PositionDetail {
  symbol: string
  direction: 'long' | 'short'
  invested_pct: number
  entry_price: number
  current_price: number
  pnl: number
  holding_time: number
}

/**
 * 计算逐笔交易统计
 */
export function calculateTradeLevelStats(trades: Trade[]): TradeLevelStats {
  const profitableTrades = trades.filter(t => (t.pnl || 0) > 0)
  const losingTrades = trades.filter(t => (t.pnl || 0) < 0)

  const avgProfit = profitableTrades.length > 0
    ? profitableTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / profitableTrades.length
    : 0

  const avgLoss = losingTrades.length > 0
    ? losingTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / losingTrades.length
    : 0

  return {
    total_trades: trades.length,
    avg_profit: avgProfit,
    avg_loss: avgLoss,
    profitable_trades_pct: trades.length > 0 ? (profitableTrades.length / trades.length) * 100 : 0,
  }
}

/**
 * 计算详细交易指标
 */
export function calculateDetailedMetrics(trades: Trade[], initialCapital: number = 10000): DetailedMetrics {
  if (trades.length === 0) {
    return {
      avg_pnl: 0,
      max_drawdown: 0,
      sharpe_ratio: 0,
      sortino_ratio: 0,
    }
  }

  // 计算累计收益
  let cumulativeValue = initialCapital
  const returns: number[] = []
  const values: number[] = [initialCapital]
  let peak = initialCapital
  let maxDrawdown = 0

  for (const trade of trades) {
    const pnl = trade.pnl || 0
    cumulativeValue += pnl
    values.push(cumulativeValue)
    
    const returnPct = pnl / initialCapital
    returns.push(returnPct)

    if (cumulativeValue > peak) {
      peak = cumulativeValue
    }
    
    const drawdown = (peak - cumulativeValue) / peak
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown
    }
  }

  const avgPnl = returns.reduce((sum, r) => sum + r, 0) / returns.length

  // 计算夏普比率（假设无风险利率为 0）
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  const stdDev = Math.sqrt(variance)
  const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0

  // 计算索提诺比率（只考虑下行波动）
  const downsideReturns = returns.filter(r => r < 0)
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
    : 0
  const downsideStdDev = Math.sqrt(downsideVariance)
  const sortinoRatio = downsideStdDev > 0 ? avgReturn / downsideStdDev : 0

  return {
    avg_pnl: avgPnl * initialCapital, // 转换为绝对金额
    max_drawdown: maxDrawdown * 100, // 转换为百分比
    sharpe_ratio: sharpeRatio,
    sortino_ratio: sortinoRatio,
  }
}

/**
 * 计算持仓时间分析
 */
export function calculateHoldingTimeAnalysis(trades: Trade[]): HoldingTimeAnalysis {
  if (trades.length === 0) {
    return {
      avg_holding_time: 0,
      median_holding_time: 0,
      short_term_trades_pct: 0,
      long_term_trades_pct: 0,
    }
  }

  const holdingTimes = trades
    .filter(t => t.holding_time_days !== undefined && t.holding_time_days !== null)
    .map(t => t.holding_time_days!)

  if (holdingTimes.length === 0) {
    return {
      avg_holding_time: 0,
      median_holding_time: 0,
      short_term_trades_pct: 0,
      long_term_trades_pct: 0,
    }
  }

  const avgHoldingTime = holdingTimes.reduce((sum, t) => sum + t, 0) / holdingTimes.length

  const sorted = [...holdingTimes].sort((a, b) => a - b)
  const medianHoldingTime = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)]

  const shortTermTrades = holdingTimes.filter(t => t < 7).length
  const longTermTrades = holdingTimes.filter(t => t > 30).length

  return {
    avg_holding_time: avgHoldingTime,
    median_holding_time: medianHoldingTime,
    short_term_trades_pct: (shortTermTrades / holdingTimes.length) * 100,
    long_term_trades_pct: (longTermTrades / holdingTimes.length) * 100,
  }
}

/**
 * 计算盈利能力分析
 */
export function calculateProfitabilityAnalysis(trades: Trade[]): ProfitabilityAnalysis {
  const profitableTrades = trades.filter(t => (t.pnl || 0) > 0)
  const losingTrades = trades.filter(t => (t.pnl || 0) < 0)

  const profits = profitableTrades.map(t => t.pnl || 0)
  const losses = losingTrades.map(t => Math.abs(t.pnl || 0))

  const largestWin = profits.length > 0 ? Math.max(...profits) : 0
  const largestLoss = losses.length > 0 ? Math.max(...losses) : 0

  const avgWin = profits.length > 0 ? profits.reduce((sum, p) => sum + p, 0) / profits.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((sum, l) => sum + l, 0) / losses.length : 0
  const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0

  return {
    profitable_trades_count: profitableTrades.length,
    losing_trades_count: losingTrades.length,
    largest_win: largestWin,
    largest_loss: largestLoss,
    win_loss_ratio: winLossRatio,
  }
}

/**
 * 计算风险指标
 */
export function calculateRiskMetrics(trades: Trade[], benchmarkReturns?: number[]): RiskMetrics {
  if (trades.length === 0) {
    return {
      volatility: 0,
      beta: 0,
      var_95: 0,
      max_leverage: 1,
    }
  }

  const returns = trades.map(t => (t.pnl || 0) / 10000) // 假设初始资金 10000

  // 计算波动率（年化）
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100 // 年化并转换为百分比

  // 计算 Beta（如果有基准数据）
  let beta = 1
  if (benchmarkReturns && benchmarkReturns.length === returns.length) {
    const benchmarkAvg = benchmarkReturns.reduce((sum, r) => sum + r, 0) / benchmarkReturns.length
    const covariance = returns.reduce((sum, r, i) => sum + (r - avgReturn) * (benchmarkReturns[i] - benchmarkAvg), 0) / returns.length
    const benchmarkVariance = benchmarkReturns.reduce((sum, r) => sum + Math.pow(r - benchmarkAvg, 2), 0) / benchmarkReturns.length
    beta = benchmarkVariance > 0 ? covariance / benchmarkVariance : 1
  }

  // 计算 VaR (95%)
  const sortedReturns = [...returns].sort((a, b) => a - b)
  const varIndex = Math.floor(sortedReturns.length * 0.05)
  const var_95 = Math.abs(sortedReturns[varIndex] || 0) * 10000 // 转换为绝对金额

  // 最大杠杆（从交易数据中推断，这里简化处理）
  const maxLeverage = 1 // 实际应从交易所 API 获取

  return {
    volatility,
    beta,
    var_95,
    max_leverage: maxLeverage,
  }
}

/**
 * 计算投资组合明细
 */
export function calculatePortfolioBreakdown(
  positions: PositionDetail[],
  totalValue: number
): PositionDetail[] {
  return positions.map(pos => ({
    ...pos,
    invested_pct: (pos.entry_price * pos.invested_pct) / totalValue * 100,
  }))
}

