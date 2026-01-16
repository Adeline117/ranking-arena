/**
 * 交易员相似度计算算法
 * 使用余弦相似度和多维度匹配
 */

import type { TradingStyle, TraderVector, SimilarTrader } from '../types/trader'

// ============================================
// 类型定义
// ============================================

interface TraderFeatures {
  id: string
  handle: string
  avatar_url?: string
  source: string
  // 绩效指标
  roi: number
  winRate: number
  maxDrawdown: number
  tradesCount: number
  avgHoldingHours: number
  volatility: number
  // 可选指标
  sharpeRatio?: number
  profitFactor?: number
}

interface SimilarityResult {
  trader: TraderFeatures
  score: number
  dimensions: string[]
  style: TradingStyle
}

// ============================================
// 配置
// ============================================

/** 特征权重配置 */
const FEATURE_WEIGHTS = {
  roi: 0.25,           // ROI 权重
  winRate: 0.20,       // 胜率权重
  maxDrawdown: 0.20,   // 回撤权重
  tradesCount: 0.15,   // 交易频率权重
  avgHoldingHours: 0.10, // 持仓时间权重
  volatility: 0.10,    // 波动率权重
}

/** 交易风格判定阈值 */
const TRADING_STYLE_THRESHOLDS = {
  high_frequency: { tradesPerDay: 5, avgHoldingHours: 4 },
  scalping: { tradesPerDay: 10, avgHoldingHours: 1 },
  swing: { tradesPerDay: 0.5, avgHoldingHours: 48 },
  position: { tradesPerDay: 0.1, avgHoldingHours: 168 },
  trend: { tradesPerDay: 0.3, avgHoldingHours: 72 },
}

// ============================================
// 核心算法
// ============================================

/**
 * 计算余弦相似度
 * cosine(A, B) = (A · B) / (||A|| * ||B||)
 */
export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error('Vectors must have the same length')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vectorA.length; i++) {
    dotProduct += vectorA[i] * vectorB[i]
    normA += vectorA[i] * vectorA[i]
    normB += vectorB[i] * vectorB[i]
  }

  normA = Math.sqrt(normA)
  normB = Math.sqrt(normB)

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (normA * normB)
}

/**
 * 特征归一化（Min-Max Scaling）
 */
export function normalizeFeatures(
  traders: TraderFeatures[],
  featureKey: keyof TraderFeatures
): Map<string, number> {
  const values = traders
    .map(t => t[featureKey])
    .filter((v): v is number => typeof v === 'number')

  if (values.length === 0) {
    return new Map()
  }

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const result = new Map<string, number>()
  traders.forEach(t => {
    const value = t[featureKey]
    if (typeof value === 'number') {
      result.set(t.id, (value - min) / range)
    }
  })

  return result
}

/**
 * 将交易员特征转换为向量
 */
export function traderToVector(
  trader: TraderFeatures,
  normalizedMaps: {
    roi: Map<string, number>
    winRate: Map<string, number>
    maxDrawdown: Map<string, number>
    tradesCount: Map<string, number>
    avgHoldingHours: Map<string, number>
    volatility: Map<string, number>
  }
): number[] {
  return [
    (normalizedMaps.roi.get(trader.id) || 0) * FEATURE_WEIGHTS.roi,
    (normalizedMaps.winRate.get(trader.id) || 0) * FEATURE_WEIGHTS.winRate,
    // 回撤是负面指标，需要反转
    (1 - (normalizedMaps.maxDrawdown.get(trader.id) || 0)) * FEATURE_WEIGHTS.maxDrawdown,
    (normalizedMaps.tradesCount.get(trader.id) || 0) * FEATURE_WEIGHTS.tradesCount,
    (normalizedMaps.avgHoldingHours.get(trader.id) || 0) * FEATURE_WEIGHTS.avgHoldingHours,
    // 波动率可能是负面或中性，取决于风格
    (normalizedMaps.volatility.get(trader.id) || 0) * FEATURE_WEIGHTS.volatility,
  ]
}

/**
 * 判定交易风格
 */
export function determineTradingStyle(trader: TraderFeatures): TradingStyle {
  const tradesPerDay = trader.tradesCount / 90 // 假设 90 天数据
  const holdingHours = trader.avgHoldingHours

  if (tradesPerDay >= TRADING_STYLE_THRESHOLDS.scalping.tradesPerDay) {
    return 'scalping'
  }
  if (tradesPerDay >= TRADING_STYLE_THRESHOLDS.high_frequency.tradesPerDay) {
    return 'high_frequency'
  }
  if (holdingHours >= TRADING_STYLE_THRESHOLDS.position.avgHoldingHours) {
    return 'position'
  }
  if (holdingHours >= TRADING_STYLE_THRESHOLDS.swing.avgHoldingHours) {
    return 'swing'
  }
  return 'trend'
}

/**
 * 获取交易风格标签名称
 */
export function getTradingStyleLabel(style: TradingStyle): string {
  const labels: Record<TradingStyle, string> = {
    high_frequency: '高频交易',
    scalping: '剥头皮',
    swing: '波段交易',
    position: '持仓交易',
    trend: '趋势跟踪',
  }
  return labels[style]
}

/**
 * 找出相似的维度
 */
function findSimilarDimensions(
  target: TraderFeatures,
  candidate: TraderFeatures,
  threshold: number = 0.2
): string[] {
  const dimensions: string[] = []

  // ROI 相似
  if (Math.abs(target.roi - candidate.roi) / Math.max(Math.abs(target.roi), 1) < threshold) {
    dimensions.push('收益率')
  }

  // 胜率相似
  if (Math.abs(target.winRate - candidate.winRate) < threshold * 100) {
    dimensions.push('胜率')
  }

  // 回撤相似
  if (Math.abs(target.maxDrawdown - candidate.maxDrawdown) < threshold * 100) {
    dimensions.push('回撤')
  }

  // 交易频率相似
  if (Math.abs(target.tradesCount - candidate.tradesCount) / Math.max(target.tradesCount, 1) < threshold) {
    dimensions.push('交易频率')
  }

  // 交易风格相同
  if (determineTradingStyle(target) === determineTradingStyle(candidate)) {
    dimensions.push('交易风格')
  }

  return dimensions
}

// ============================================
// 主函数
// ============================================

/**
 * 查找相似交易员
 * @param targetId 目标交易员 ID
 * @param allTraders 所有候选交易员
 * @param limit 返回数量限制
 */
export function findSimilarTraders(
  targetId: string,
  allTraders: TraderFeatures[],
  limit: number = 6
): SimilarityResult[] {
  const target = allTraders.find(t => t.id === targetId)
  if (!target) {
    return []
  }

  const candidates = allTraders.filter(t => t.id !== targetId)
  if (candidates.length === 0) {
    return []
  }

  // 归一化所有特征
  const normalizedMaps = {
    roi: normalizeFeatures(allTraders, 'roi'),
    winRate: normalizeFeatures(allTraders, 'winRate'),
    maxDrawdown: normalizeFeatures(allTraders, 'maxDrawdown'),
    tradesCount: normalizeFeatures(allTraders, 'tradesCount'),
    avgHoldingHours: normalizeFeatures(allTraders, 'avgHoldingHours'),
    volatility: normalizeFeatures(allTraders, 'volatility'),
  }

  // 计算目标向量
  const targetVector = traderToVector(target, normalizedMaps)

  // 计算所有候选者的相似度
  const results: SimilarityResult[] = candidates.map(candidate => {
    const candidateVector = traderToVector(candidate, normalizedMaps)
    const score = cosineSimilarity(targetVector, candidateVector)
    const dimensions = findSimilarDimensions(target, candidate)
    const style = determineTradingStyle(candidate)

    return {
      trader: candidate,
      score,
      dimensions,
      style,
    }
  })

  // 按相似度排序
  results.sort((a, b) => b.score - a.score)

  // 返回前 N 个
  return results.slice(0, limit)
}

/**
 * 将相似度结果转换为 SimilarTrader 格式
 */
export function toSimilarTraders(results: SimilarityResult[]): SimilarTrader[] {
  return results.map(r => ({
    handle: r.trader.handle,
    id: r.trader.id,
    avatar_url: r.trader.avatar_url,
    source: r.trader.source,
    tradingStyle: r.style,
    similarityScore: Math.round(r.score * 100) / 100,
    similarDimensions: r.dimensions,
  }))
}

/**
 * 基于风格筛选相似交易员
 * 优先返回相同风格的交易员
 */
export function findSimilarByStyle(
  targetId: string,
  allTraders: TraderFeatures[],
  limit: number = 6
): SimilarityResult[] {
  const target = allTraders.find(t => t.id === targetId)
  if (!target) {
    return []
  }

  const targetStyle = determineTradingStyle(target)
  const candidates = allTraders.filter(t => t.id !== targetId)

  // 优先相同风格
  const sameStyle = candidates.filter(t => determineTradingStyle(t) === targetStyle)
  const differentStyle = candidates.filter(t => determineTradingStyle(t) !== targetStyle)

  // 对相同风格的使用相似度排序
  const sameStyleResults = findSimilarTraders(targetId, [target, ...sameStyle], limit)
  
  // 如果相同风格不够，补充不同风格的
  if (sameStyleResults.length < limit && differentStyle.length > 0) {
    const additionalResults = findSimilarTraders(targetId, [target, ...differentStyle], limit - sameStyleResults.length)
    return [...sameStyleResults, ...additionalResults]
  }

  return sameStyleResults
}
