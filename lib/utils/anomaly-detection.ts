/**
 * 异常检测模块
 * 提供多种异常检测算法
 */

import type { TraderRankingData } from './ranking'

// ============================================
// 类型定义
// ============================================

export interface AnomalyResult {
  traderId: string
  isAnomaly: boolean
  anomalyScore: number // 0-1, 越高越异常
  anomalyType: AnomalyType[]
  confidence: number // 置信度 0-1
  details: AnomalyDetail[]
}

export type AnomalyType = 
  | 'statistical_outlier'    // 统计异常值
  | 'data_inconsistency'     // 数据不一致
  | 'suspicious_pattern'     // 可疑模式
  | 'time_series_anomaly'    // 时序异常
  | 'behavioral_anomaly'     // 行为异常

export interface AnomalyDetail {
  field: string
  value: number
  zScore?: number
  threshold?: number
  description: string
}

// 配置
export const AnomalyConfig = {
  // Z-Score 阈值
  Z_SCORE_THRESHOLD: 2.5,
  
  // IQR 乘数（用于箱线图方法）
  IQR_MULTIPLIER: 1.5,
  
  // 最小样本数量（低于此数不计算统计异常）
  MIN_SAMPLE_SIZE: 10,
  
  // 各指标权重
  WEIGHTS: {
    roi: 0.35,
    win_rate: 0.2,
    max_drawdown: 0.25,
    trades_count: 0.1,
    pnl: 0.1,
  },
  
  // 异常阈值配置
  THRESHOLDS: {
    // ROI 异常阈值
    ROI_MAX: 1000,
    ROI_MIN: -99,
    
    // 胜率阈值
    WIN_RATE_MAX: 100,
    WIN_RATE_MIN: 0,
    WIN_RATE_SUSPICIOUS: 95, // 过高胜率可疑
    
    // 回撤阈值
    DRAWDOWN_SUSPICIOUS_LOW: 1, // 几乎无回撤可疑
    
    // 交易次数阈值
    TRADES_MIN: 3,
    
    // PnL 与 ROI 关系
    MIN_PNL_FOR_HIGH_ROI: 1000,
  },
} as const

// ============================================
// 统计工具函数
// ============================================

/**
 * 计算数组的均值
 */
export function calculateMean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * 计算数组的标准差
 */
export function calculateStdDev(values: number[], mean?: number): number {
  if (values.length < 2) return 0
  const m = mean ?? calculateMean(values)
  const squaredDiffs = values.map(v => Math.pow(v - m, 2))
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1))
}

/**
 * 计算 Z-Score
 */
export function calculateZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0
  return (value - mean) / stdDev
}

/**
 * 计算四分位数
 */
export function calculateQuartiles(values: number[]): { q1: number; median: number; q3: number; iqr: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  
  if (n === 0) return { q1: 0, median: 0, q3: 0, iqr: 0 }
  
  const q1Index = Math.floor(n * 0.25)
  const medianIndex = Math.floor(n * 0.5)
  const q3Index = Math.floor(n * 0.75)
  
  const q1 = sorted[q1Index]
  const median = sorted[medianIndex]
  const q3 = sorted[q3Index]
  
  return { q1, median, q3, iqr: q3 - q1 }
}

// ============================================
// Z-Score 异常检测
// ============================================

type TraderFieldKey = 'roi' | 'win_rate' | 'max_drawdown' | 'trades_count' | 'pnl'

/**
 * 使用 Z-Score 检测单个字段的异常值
 */
export function detectByZScore(
  traders: TraderRankingData[],
  field: TraderFieldKey,
  threshold: number = AnomalyConfig.Z_SCORE_THRESHOLD
): Map<string, { zScore: number; isOutlier: boolean }> {
  const results = new Map<string, { zScore: number; isOutlier: boolean }>()
  
  // 提取有效值
  const validValues: { id: string; value: number }[] = []
  for (const trader of traders) {
    const value = trader[field]
    if (value != null && !isNaN(value)) {
      validValues.push({ id: trader.id, value })
    }
  }
  
  if (validValues.length < AnomalyConfig.MIN_SAMPLE_SIZE) {
    return results
  }
  
  // 计算统计量
  const values = validValues.map(v => v.value)
  const mean = calculateMean(values)
  const stdDev = calculateStdDev(values, mean)
  
  // 计算每个交易员的 Z-Score
  for (const { id, value } of validValues) {
    const zScore = calculateZScore(value, mean, stdDev)
    results.set(id, {
      zScore,
      isOutlier: Math.abs(zScore) > threshold,
    })
  }
  
  return results
}

/**
 * 使用 IQR 方法检测异常值
 */
export function detectByIQR(
  traders: TraderRankingData[],
  field: TraderFieldKey,
  multiplier: number = AnomalyConfig.IQR_MULTIPLIER
): Map<string, { isOutlier: boolean; direction: 'high' | 'low' | null }> {
  const results = new Map<string, { isOutlier: boolean; direction: 'high' | 'low' | null }>()
  
  const validValues: { id: string; value: number }[] = []
  for (const trader of traders) {
    const value = trader[field]
    if (value != null && !isNaN(value)) {
      validValues.push({ id: trader.id, value })
    }
  }
  
  if (validValues.length < AnomalyConfig.MIN_SAMPLE_SIZE) {
    return results
  }
  
  const values = validValues.map(v => v.value)
  const { q1, q3, iqr } = calculateQuartiles(values)
  
  const lowerBound = q1 - multiplier * iqr
  const upperBound = q3 + multiplier * iqr
  
  for (const { id, value } of validValues) {
    let direction: 'high' | 'low' | null = null
    let isOutlier = false
    
    if (value < lowerBound) {
      isOutlier = true
      direction = 'low'
    } else if (value > upperBound) {
      isOutlier = true
      direction = 'high'
    }
    
    results.set(id, { isOutlier, direction })
  }
  
  return results
}

// ============================================
// 多维度联合检测
// ============================================

/**
 * 多维度异常检测
 * 综合考虑多个指标的异常情况
 */
export function detectMultiDimensional(
  trader: TraderRankingData,
  allTraders: TraderRankingData[]
): AnomalyResult {
  const details: AnomalyDetail[] = []
  const anomalyTypes: AnomalyType[] = []
  let totalAnomalyScore = 0
  let weightSum = 0
  
  // 1. 检测各字段的 Z-Score 异常
  const fields: TraderFieldKey[] = ['roi', 'win_rate', 'max_drawdown', 'trades_count', 'pnl']
  
  for (const field of fields) {
    const value = trader[field]
    if (value == null) continue
    
    const zScoreResults = detectByZScore(allTraders, field)
    const result = zScoreResults.get(trader.id)
    
    if (result) {
      const weight = AnomalyConfig.WEIGHTS[field]
      weightSum += weight
      
      if (result.isOutlier) {
        totalAnomalyScore += weight * Math.min(Math.abs(result.zScore) / 5, 1)
        
        details.push({
          field,
          value,
          zScore: result.zScore,
          threshold: AnomalyConfig.Z_SCORE_THRESHOLD,
          description: `${field} Z-Score: ${result.zScore.toFixed(2)} (阈值: ±${AnomalyConfig.Z_SCORE_THRESHOLD})`,
        })
        
        if (!anomalyTypes.includes('statistical_outlier')) {
          anomalyTypes.push('statistical_outlier')
        }
      }
    }
  }
  
  // 2. 检测数据不一致
  const inconsistencies = detectDataInconsistency(trader)
  if (inconsistencies.length > 0) {
    anomalyTypes.push('data_inconsistency')
    details.push(...inconsistencies)
    totalAnomalyScore += 0.3 * inconsistencies.length
    weightSum += 0.3 * inconsistencies.length
  }
  
  // 3. 检测可疑模式
  const suspiciousPatterns = detectSuspiciousPatterns(trader)
  if (suspiciousPatterns.length > 0) {
    anomalyTypes.push('suspicious_pattern')
    details.push(...suspiciousPatterns)
    totalAnomalyScore += 0.25 * suspiciousPatterns.length
    weightSum += 0.25 * suspiciousPatterns.length
  }
  
  // 计算最终异常分数
  const anomalyScore = weightSum > 0 ? Math.min(totalAnomalyScore / weightSum, 1) : 0
  
  // 计算置信度（基于样本数量和异常类型数量）
  const confidence = calculateConfidence(allTraders.length, anomalyTypes.length)
  
  return {
    traderId: trader.id,
    isAnomaly: anomalyScore > 0.3 || anomalyTypes.length >= 2,
    anomalyScore,
    anomalyType: anomalyTypes,
    confidence,
    details,
  }
}

/**
 * 检测数据不一致
 */
function detectDataInconsistency(trader: TraderRankingData): AnomalyDetail[] {
  const details: AnomalyDetail[] = []
  const { THRESHOLDS } = AnomalyConfig
  
  // ROI 范围检查
  if (trader.roi > THRESHOLDS.ROI_MAX) {
    details.push({
      field: 'roi',
      value: trader.roi,
      threshold: THRESHOLDS.ROI_MAX,
      description: `ROI (${trader.roi.toFixed(2)}%) 超过正常范围 (>${THRESHOLDS.ROI_MAX}%)`,
    })
  }
  
  if (trader.roi < THRESHOLDS.ROI_MIN) {
    details.push({
      field: 'roi',
      value: trader.roi,
      threshold: THRESHOLDS.ROI_MIN,
      description: `ROI (${trader.roi.toFixed(2)}%) 低于正常范围 (<${THRESHOLDS.ROI_MIN}%)`,
    })
  }
  
  // 胜率检查
  if (trader.win_rate != null) {
    if (trader.win_rate > THRESHOLDS.WIN_RATE_MAX || trader.win_rate < THRESHOLDS.WIN_RATE_MIN) {
      details.push({
        field: 'win_rate',
        value: trader.win_rate,
        description: `胜率 (${trader.win_rate.toFixed(2)}%) 超出有效范围 (0-100%)`,
      })
    }
  }
  
  // 低 PnL 配合高 ROI
  if (trader.pnl < THRESHOLDS.MIN_PNL_FOR_HIGH_ROI && trader.roi > 100) {
    details.push({
      field: 'pnl',
      value: trader.pnl,
      threshold: THRESHOLDS.MIN_PNL_FOR_HIGH_ROI,
      description: `低 PnL ($${trader.pnl.toFixed(0)}) 配合高 ROI (${trader.roi.toFixed(2)}%)`,
    })
  }
  
  return details
}

/**
 * 检测可疑模式
 */
function detectSuspiciousPatterns(trader: TraderRankingData): AnomalyDetail[] {
  const details: AnomalyDetail[] = []
  const { THRESHOLDS } = AnomalyConfig
  
  // 极高胜率
  if (trader.win_rate != null && trader.win_rate > THRESHOLDS.WIN_RATE_SUSPICIOUS) {
    details.push({
      field: 'win_rate',
      value: trader.win_rate,
      threshold: THRESHOLDS.WIN_RATE_SUSPICIOUS,
      description: `胜率异常高 (${trader.win_rate.toFixed(2)}%)，可能存在数据问题`,
    })
  }
  
  // 几乎无回撤但高 ROI
  if (trader.max_drawdown != null) {
    const absDrawdown = Math.abs(trader.max_drawdown)
    if (absDrawdown < THRESHOLDS.DRAWDOWN_SUSPICIOUS_LOW && trader.roi > 50) {
      details.push({
        field: 'max_drawdown',
        value: trader.max_drawdown,
        threshold: THRESHOLDS.DRAWDOWN_SUSPICIOUS_LOW,
        description: `几乎无回撤 (${absDrawdown.toFixed(2)}%) 配合高 ROI (${trader.roi.toFixed(2)}%)`,
      })
    }
  }
  
  // 极少交易但高 ROI
  if (trader.trades_count != null && trader.trades_count < THRESHOLDS.TRADES_MIN && trader.roi > 100) {
    details.push({
      field: 'trades_count',
      value: trader.trades_count,
      threshold: THRESHOLDS.TRADES_MIN,
      description: `极少交易 (${trader.trades_count} 次) 配合高 ROI (${trader.roi.toFixed(2)}%)`,
    })
  }
  
  return details
}

/**
 * 计算置信度
 */
function calculateConfidence(sampleSize: number, anomalyTypeCount: number): number {
  // 样本量对置信度的影响
  const sampleConfidence = Math.min(sampleSize / 100, 1)
  
  // 多种异常类型会增加置信度
  const typeConfidence = Math.min(anomalyTypeCount / 3, 1) * 0.3 + 0.7
  
  return sampleConfidence * typeConfidence
}

// ============================================
// 时序异常检测
// ============================================

/**
 * 检测收益曲线异常
 * 用于识别突然的收益跳变
 */
export function detectEquityCurveAnomaly(
  equityCurve: number[],
  windowSize: number = 5
): { hasAnomaly: boolean; anomalyPoints: number[] } {
  const anomalyPoints: number[] = []
  
  if (equityCurve.length < windowSize * 2) {
    return { hasAnomaly: false, anomalyPoints }
  }
  
  // 计算收益率变化
  const returns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] !== 0) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1] * 100)
    }
  }
  
  // 使用滑动窗口检测异常点
  for (let i = windowSize; i < returns.length - windowSize; i++) {
    const windowBefore = returns.slice(i - windowSize, i)
    const windowAfter = returns.slice(i, i + windowSize)
    
    const meanBefore = calculateMean(windowBefore)
    const meanAfter = calculateMean(windowAfter)
    const stdBefore = calculateStdDev(windowBefore, meanBefore)
    
    // 如果后一个窗口的均值与前一个窗口相差超过 3 个标准差，标记为异常
    if (stdBefore > 0 && Math.abs(meanAfter - meanBefore) > 3 * stdBefore) {
      anomalyPoints.push(i)
    }
  }
  
  return {
    hasAnomaly: anomalyPoints.length > 0,
    anomalyPoints,
  }
}

// ============================================
// 批量异常检测
// ============================================

/**
 * 对所有交易员进行异常检测
 */
export function detectAnomaliesForAll(traders: TraderRankingData[]): Map<string, AnomalyResult> {
  const results = new Map<string, AnomalyResult>()
  
  for (const trader of traders) {
    const result = detectMultiDimensional(trader, traders)
    results.set(trader.id, result)
  }
  
  return results
}

/**
 * 获取异常交易员列表
 */
export function getAnomalousTraders(traders: TraderRankingData[]): AnomalyResult[] {
  const allResults = detectAnomaliesForAll(traders)
  const anomalous: AnomalyResult[] = []
  
  for (const result of allResults.values()) {
    if (result.isAnomaly) {
      anomalous.push(result)
    }
  }
  
  // 按异常分数排序
  return anomalous.sort((a, b) => b.anomalyScore - a.anomalyScore)
}
