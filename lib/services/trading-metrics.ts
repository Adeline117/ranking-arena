/**
 * 专业交易风险指标计算服务
 * 提供夏普率、波动率、索提诺比率等专业指标的计算
 */

// ============================================
// 类型定义
// ============================================

export interface PerformanceData {
  /** 收益率序列（百分比） */
  returns: number[]
  /** 周期类型 */
  period: 'daily' | 'weekly' | 'monthly'
}

export interface RiskMetrics {
  /** 夏普率 - 风险调整收益指标 */
  sharpeRatio: number | null
  /** 索提诺比率 - 只考虑下行风险的风险调整收益 */
  sortinoRatio: number | null
  /** 卡尔马比率 - 年化收益/最大回撤 */
  calmarRatio: number | null
  /** 波动率（年化，百分比） */
  volatility: number | null
  /** 下行波动率（年化，百分比） */
  downwardVolatility: number | null
  /** 最大回撤（百分比） */
  maxDrawdown: number | null
  /** 最大回撤持续天数 */
  maxDrawdownDuration: number | null
  /** 最大连续亏损次数 */
  maxConsecutiveLosses: number | null
  /** 最大连续盈利次数 */
  maxConsecutiveWins: number | null
  /** 盈亏比（平均盈利/平均亏损） */
  profitLossRatio: number | null
  /** 收益风险比 (期望收益/风险) */
  rewardRiskRatio: number | null
  /** 风险评级 (1-5，5为最高风险) */
  riskLevel: 1 | 2 | 3 | 4 | 5
  /** 风险评级描述 */
  riskLevelDescription: string
}

export interface TradeRecord {
  pnl: number      // 盈亏金额
  pnlPct: number   // 盈亏百分比
  openTime: string
  closeTime: string
}

// ============================================
// 常量配置
// ============================================

/** 年化因子 */
const ANNUALIZATION_FACTOR = {
  daily: Math.sqrt(365),
  weekly: Math.sqrt(52),
  monthly: Math.sqrt(12),
}

/** 无风险利率（年化，假设为 4%） */
const RISK_FREE_RATE = 0.04

/** 风险等级阈值 */
const RISK_LEVEL_THRESHOLDS = {
  volatility: [10, 25, 50, 100], // 波动率阈值
  maxDrawdown: [5, 15, 30, 50],  // 最大回撤阈值
  sharpe: [2, 1, 0.5, 0],        // 夏普率阈值（倒序）
}

// ============================================
// 基础计算函数
// ============================================

/**
 * 计算平均值
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * 计算标准差
 */
function standardDeviation(values: number[], avg?: number): number {
  if (values.length < 2) return 0
  const m = avg ?? mean(values)
  const squaredDiffs = values.map(v => Math.pow(v - m, 2))
  return Math.sqrt(mean(squaredDiffs))
}

/**
 * 计算下行标准差（只考虑负收益）
 */
function downwardStandardDeviation(values: number[], threshold = 0): number {
  const negativeReturns = values.filter(v => v < threshold)
  if (negativeReturns.length < 2) return 0
  const squaredDiffs = negativeReturns.map(v => Math.pow(v - threshold, 2))
  return Math.sqrt(mean(squaredDiffs))
}

// ============================================
// 风险指标计算函数
// ============================================

/**
 * 计算夏普率
 * Sharpe Ratio = (Portfolio Return - Risk-Free Rate) / Portfolio Std Dev
 */
export function calculateSharpeRatio(
  returns: number[],
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  riskFreeRate = RISK_FREE_RATE
): number | null {
  if (returns.length < 10) return null

  const avgReturn = mean(returns)
  const stdDev = standardDeviation(returns, avgReturn)

  if (stdDev === 0) return null

  // 年化
  const annualizationFactor = ANNUALIZATION_FACTOR[period]
  const annualizedReturn = avgReturn * (period === 'daily' ? 365 : period === 'weekly' ? 52 : 12)
  const annualizedStdDev = stdDev * annualizationFactor

  const sharpe = (annualizedReturn / 100 - riskFreeRate) / (annualizedStdDev / 100)
  
  return Math.round(sharpe * 100) / 100
}

/**
 * 计算索提诺比率
 * Sortino Ratio = (Portfolio Return - Target Return) / Downward Std Dev
 */
export function calculateSortinoRatio(
  returns: number[],
  period: 'daily' | 'weekly' | 'monthly' = 'daily',
  targetReturn = 0
): number | null {
  if (returns.length < 10) return null

  const avgReturn = mean(returns)
  const downwardStdDev = downwardStandardDeviation(returns, targetReturn)

  if (downwardStdDev === 0) return null

  // 年化
  const annualizationFactor = ANNUALIZATION_FACTOR[period]
  const annualizedReturn = avgReturn * (period === 'daily' ? 365 : period === 'weekly' ? 52 : 12)
  const annualizedDownwardStdDev = downwardStdDev * annualizationFactor

  const sortino = (annualizedReturn / 100) / (annualizedDownwardStdDev / 100)
  
  return Math.round(sortino * 100) / 100
}

/**
 * 计算卡尔马比率
 * Calmar Ratio = Annual Return / Max Drawdown
 */
export function calculateCalmarRatio(
  annualizedReturn: number,
  maxDrawdown: number
): number | null {
  if (maxDrawdown === 0) return null
  const calmar = annualizedReturn / Math.abs(maxDrawdown)
  return Math.round(calmar * 100) / 100
}

/**
 * 计算波动率（年化）
 */
export function calculateVolatility(
  returns: number[],
  period: 'daily' | 'weekly' | 'monthly' = 'daily'
): number | null {
  if (returns.length < 10) return null

  const stdDev = standardDeviation(returns)
  const annualizationFactor = ANNUALIZATION_FACTOR[period]
  const annualizedVol = stdDev * annualizationFactor

  return Math.round(annualizedVol * 100) / 100
}

/**
 * 计算最大回撤
 */
export function calculateMaxDrawdown(returns: number[]): {
  maxDrawdown: number
  maxDrawdownDuration: number
} {
  if (returns.length === 0) {
    return { maxDrawdown: 0, maxDrawdownDuration: 0 }
  }

  // 计算累积收益
  let cumulativeReturn = 100 // 从 100 开始
  const peaks: number[] = []
  const drawdowns: number[] = []
  
  let peak = cumulativeReturn
  let maxDD = 0
  let currentDDStart = -1
  let maxDDDuration = 0
  let currentDDLength = 0

  returns.forEach((ret, idx) => {
    cumulativeReturn *= (1 + ret / 100)
    
    if (cumulativeReturn > peak) {
      peak = cumulativeReturn
      if (currentDDStart >= 0) {
        maxDDDuration = Math.max(maxDDDuration, currentDDLength)
      }
      currentDDStart = -1
      currentDDLength = 0
    } else {
      if (currentDDStart < 0) currentDDStart = idx
      currentDDLength++
      const dd = ((peak - cumulativeReturn) / peak) * 100
      maxDD = Math.max(maxDD, dd)
    }
    
    peaks.push(peak)
    drawdowns.push(((peak - cumulativeReturn) / peak) * 100)
  })

  // 检查最后的回撤持续时间
  if (currentDDStart >= 0) {
    maxDDDuration = Math.max(maxDDDuration, currentDDLength)
  }

  return {
    maxDrawdown: Math.round(maxDD * 100) / 100,
    maxDrawdownDuration: maxDDDuration,
  }
}

/**
 * 计算最大连续亏损/盈利次数
 */
export function calculateConsecutiveStreak(trades: TradeRecord[]): {
  maxConsecutiveLosses: number
  maxConsecutiveWins: number
} {
  let maxLosses = 0
  let maxWins = 0
  let currentLosses = 0
  let currentWins = 0

  trades.forEach(trade => {
    if (trade.pnl < 0) {
      currentLosses++
      currentWins = 0
      maxLosses = Math.max(maxLosses, currentLosses)
    } else if (trade.pnl > 0) {
      currentWins++
      currentLosses = 0
      maxWins = Math.max(maxWins, currentWins)
    }
  })

  return { maxConsecutiveLosses: maxLosses, maxConsecutiveWins: maxWins }
}

/**
 * 计算盈亏比
 */
export function calculateProfitLossRatio(trades: TradeRecord[]): number | null {
  const profits = trades.filter(t => t.pnl > 0).map(t => t.pnl)
  const losses = trades.filter(t => t.pnl < 0).map(t => Math.abs(t.pnl))

  if (profits.length === 0 || losses.length === 0) return null

  const avgProfit = mean(profits)
  const avgLoss = mean(losses)

  if (avgLoss === 0) return null

  return Math.round((avgProfit / avgLoss) * 100) / 100
}

/**
 * 计算风险等级
 */
export function calculateRiskLevel(
  volatility: number | null,
  maxDrawdown: number | null,
  sharpeRatio: number | null
): { level: 1 | 2 | 3 | 4 | 5; description: string } {
  let score = 0

  // 波动率评分
  if (volatility !== null) {
    if (volatility > RISK_LEVEL_THRESHOLDS.volatility[3]) score += 4
    else if (volatility > RISK_LEVEL_THRESHOLDS.volatility[2]) score += 3
    else if (volatility > RISK_LEVEL_THRESHOLDS.volatility[1]) score += 2
    else if (volatility > RISK_LEVEL_THRESHOLDS.volatility[0]) score += 1
  }

  // 最大回撤评分
  if (maxDrawdown !== null) {
    const absDD = Math.abs(maxDrawdown)
    if (absDD > RISK_LEVEL_THRESHOLDS.maxDrawdown[3]) score += 4
    else if (absDD > RISK_LEVEL_THRESHOLDS.maxDrawdown[2]) score += 3
    else if (absDD > RISK_LEVEL_THRESHOLDS.maxDrawdown[1]) score += 2
    else if (absDD > RISK_LEVEL_THRESHOLDS.maxDrawdown[0]) score += 1
  }

  // 夏普率评分（夏普率越高越好，所以反向评分）
  if (sharpeRatio !== null) {
    if (sharpeRatio < RISK_LEVEL_THRESHOLDS.sharpe[3]) score += 4
    else if (sharpeRatio < RISK_LEVEL_THRESHOLDS.sharpe[2]) score += 3
    else if (sharpeRatio < RISK_LEVEL_THRESHOLDS.sharpe[1]) score += 2
    else if (sharpeRatio < RISK_LEVEL_THRESHOLDS.sharpe[0]) score += 1
  }

  // 平均分（3项指标）
  const avgScore = score / 3
  
  let level: 1 | 2 | 3 | 4 | 5
  let description: string

  if (avgScore <= 1) {
    level = 1
    description = '低风险'
  } else if (avgScore <= 1.5) {
    level = 2
    description = '较低风险'
  } else if (avgScore <= 2.5) {
    level = 3
    description = '中等风险'
  } else if (avgScore <= 3.5) {
    level = 4
    description = '较高风险'
  } else {
    level = 5
    description = '高风险'
  }

  return { level, description }
}

// ============================================
// 综合计算函数
// ============================================

/**
 * 计算所有风险指标
 */
export function calculateAllRiskMetrics(
  data: PerformanceData,
  trades?: TradeRecord[],
  annualizedReturn?: number
): RiskMetrics {
  const { returns, period } = data

  // 基础指标
  const volatility = calculateVolatility(returns, period)
  const sharpeRatio = calculateSharpeRatio(returns, period)
  const sortinoRatio = calculateSortinoRatio(returns, period)
  
  // 最大回撤
  const { maxDrawdown, maxDrawdownDuration } = calculateMaxDrawdown(returns)
  
  // 下行波动率
  const downwardVol = downwardStandardDeviation(returns) * ANNUALIZATION_FACTOR[period]
  const downwardVolatility = Math.round(downwardVol * 100) / 100

  // 卡尔马比率
  const calmarRatio = annualizedReturn !== undefined 
    ? calculateCalmarRatio(annualizedReturn, maxDrawdown)
    : null

  // 交易相关指标
  let maxConsecutiveLosses: number | null = null
  let maxConsecutiveWins: number | null = null
  let profitLossRatio: number | null = null

  if (trades && trades.length > 0) {
    const streaks = calculateConsecutiveStreak(trades)
    maxConsecutiveLosses = streaks.maxConsecutiveLosses
    maxConsecutiveWins = streaks.maxConsecutiveWins
    profitLossRatio = calculateProfitLossRatio(trades)
  }

  // 收益风险比
  const rewardRiskRatio = volatility && volatility > 0 && annualizedReturn !== undefined
    ? Math.round((annualizedReturn / volatility) * 100) / 100
    : null

  // 风险等级
  const { level: riskLevel, description: riskLevelDescription } = calculateRiskLevel(
    volatility,
    maxDrawdown,
    sharpeRatio
  )

  return {
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    volatility,
    downwardVolatility,
    maxDrawdown,
    maxDrawdownDuration,
    maxConsecutiveLosses,
    maxConsecutiveWins,
    profitLossRatio,
    rewardRiskRatio,
    riskLevel,
    riskLevelDescription,
  }
}

/**
 * 格式化风险指标用于显示
 */
export function formatRiskMetric(
  value: number | null,
  type: 'ratio' | 'percentage' | 'days' | 'count'
): string {
  if (value === null || value === undefined) return '—'

  switch (type) {
    case 'ratio':
      return value.toFixed(2)
    case 'percentage':
      return `${value.toFixed(2)}%`
    case 'days':
      return `${value} 天`
    case 'count':
      return `${value} 次`
    default:
      return String(value)
  }
}
