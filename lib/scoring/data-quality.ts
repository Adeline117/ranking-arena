/**
 * 数据质量评分系统
 * 
 * 为每条交易员数据计算质量分数，考虑因素：
 * - 字段完整性（ROI/WR/DD/PnL）
 * - 数据新鲜度
 * - 来源可靠性
 * 
 * 质量分可作为 Arena Score 的权重因子
 */

import { SOURCE_RELIABILITY, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

// ============================================
// 类型定义
// ============================================

export interface DataQualityInput {
  // 核心指标
  roi: number | null | undefined
  pnl: number | null | undefined
  winRate: number | null | undefined
  maxDrawdown: number | null | undefined
  
  // 附加指标
  followers: number | null | undefined
  tradesCount: number | null | undefined
  copiers: number | null | undefined
  aum: number | null | undefined
  
  // 元数据
  source: string
  capturedAt: string | Date | null | undefined
  updatedAt: string | Date | null | undefined
}

export interface DataQualityResult {
  /** 总质量分 (0-100) */
  totalScore: number
  
  /** 字段完整性分 (0-40) */
  completenessScore: number
  
  /** 数据新鲜度分 (0-30) */
  freshnessScore: number
  
  /** 来源可靠性分 (0-30) */
  reliabilityScore: number
  
  /** 质量等级 */
  qualityGrade: DataQualityGrade
  
  /** 缺失字段列表 */
  missingFields: string[]
  
  /** 数据年龄（小时） */
  dataAgeHours: number | null
}

export type DataQualityGrade = 'A' | 'B' | 'C' | 'D' | 'F'

// ============================================
// 配置参数
// ============================================

export const DATA_QUALITY_CONFIG = {
  // 分数权重
  WEIGHTS: {
    completeness: 40,  // 字段完整性权重
    freshness: 30,     // 数据新鲜度权重
    reliability: 30,   // 来源可靠性权重
  },
  
  // 字段权重（总和 = 1.0）
  FIELD_WEIGHTS: {
    roi: 0.30,         // ROI 最重要
    pnl: 0.20,         // PnL 次之
    winRate: 0.20,     // 胜率
    maxDrawdown: 0.15, // 最大回撤
    followers: 0.05,   // 跟随者数
    tradesCount: 0.05, // 交易次数
    copiers: 0.03,     // 跟单者数
    aum: 0.02,         // 管理资产
  },
  
  // 新鲜度衰减参数（小时）
  FRESHNESS: {
    perfect: 4,        // 4小时内 = 满分
    good: 12,          // 12小时内 = 80%
    acceptable: 24,    // 24小时内 = 60%
    stale: 72,         // 72小时内 = 30%
    expired: 168,      // 7天后 = 0%
  },
  
  // 来源可靠性基础分（可被 SOURCE_RELIABILITY 覆盖）
  DEFAULT_SOURCE_RELIABILITY: 70,
  
  // 质量等级阈值
  GRADE_THRESHOLDS: {
    A: 85,
    B: 70,
    C: 55,
    D: 40,
    // F: < 40
  },
} as const

// ============================================
// 来源可靠性配置
// ============================================

/**
 * 各平台数据可靠性评分 (0-100)
 * 基于 OPTIMIZATION_PLAN.md 的评估
 */
export const PLATFORM_RELIABILITY: Record<string, number> = {
  // ⭐⭐⭐⭐⭐ 稳定平台 (90-100)
  'okx-futures': 95,
  'okx-web3': 90,
  'htx': 95,
  'gains': 95,
  'hyperliquid': 95,
  'gmx': 95,
  'dydx': 90,
  'kwenta': 88,
  'mux': 88,
  
  // ⭐⭐⭐⭐ 需代理但稳定 (80-89)
  'binance-futures': 88,
  'binance-spot': 88,
  'binance-web3': 85,
  
  // ⭐⭐⭐ 需浏览器/有限制 (60-79)
  'mexc': 75,
  'kucoin': 72,
  'coinex': 72,
  'weex': 70,
  'phemex': 70,
  'bitget-futures': 68,
  'bitget-spot': 65,
  'xt': 55,
  
  // ⭐⭐ 不稳定/数据少 (40-59)
  'bybit': 45,
  'bybit-spot': 45,
  'bingx': 40,
  'blofin': 40,
  'lbank': 35,
  
  // 默认值
  'default': 60,
}

// ============================================
// 工具函数
// ============================================

/**
 * 判断字段是否有效（非空且非0）
 */
function isValidField(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return !isNaN(value) && value !== 0
  return true
}

/**
 * 计算数据年龄（小时）
 */
function calculateDataAgeHours(capturedAt: string | Date | null | undefined): number | null {
  if (!capturedAt) return null
  
  try {
    const capturedDate = typeof capturedAt === 'string' ? new Date(capturedAt) : capturedAt
    if (isNaN(capturedDate.getTime())) return null
    
    const now = new Date()
    const diffMs = now.getTime() - capturedDate.getTime()
    return diffMs / (1000 * 60 * 60)
  } catch {
    return null
  }
}

/**
 * 计算新鲜度分数（0-1）
 */
function calculateFreshnessRatio(ageHours: number | null): number {
  if (ageHours === null) return 0.3 // 无时间戳给予较低分数
  
  const { FRESHNESS } = DATA_QUALITY_CONFIG
  
  if (ageHours <= FRESHNESS.perfect) return 1.0
  if (ageHours <= FRESHNESS.good) {
    // 4-12小时：线性从 1.0 降到 0.8
    return 1.0 - (ageHours - FRESHNESS.perfect) / (FRESHNESS.good - FRESHNESS.perfect) * 0.2
  }
  if (ageHours <= FRESHNESS.acceptable) {
    // 12-24小时：从 0.8 降到 0.6
    return 0.8 - (ageHours - FRESHNESS.good) / (FRESHNESS.acceptable - FRESHNESS.good) * 0.2
  }
  if (ageHours <= FRESHNESS.stale) {
    // 24-72小时：从 0.6 降到 0.3
    return 0.6 - (ageHours - FRESHNESS.acceptable) / (FRESHNESS.stale - FRESHNESS.acceptable) * 0.3
  }
  if (ageHours <= FRESHNESS.expired) {
    // 72-168小时：从 0.3 降到 0
    return 0.3 - (ageHours - FRESHNESS.stale) / (FRESHNESS.expired - FRESHNESS.stale) * 0.3
  }
  
  return 0 // 超过7天
}

/**
 * 获取平台可靠性分数
 */
function getPlatformReliability(source: string): number {
  // 尝试直接匹配
  if (PLATFORM_RELIABILITY[source]) {
    return PLATFORM_RELIABILITY[source]
  }
  
  // 尝试标准化名称匹配
  const normalized = source.toLowerCase().replace(/[_\s]/g, '-')
  if (PLATFORM_RELIABILITY[normalized]) {
    return PLATFORM_RELIABILITY[normalized]
  }
  
  // 尝试从 SOURCE_RELIABILITY 获取（如果存在）
  if (typeof SOURCE_RELIABILITY === 'object' && SOURCE_RELIABILITY?.[source]) {
    return SOURCE_RELIABILITY[source]
  }
  
  return DATA_QUALITY_CONFIG.DEFAULT_SOURCE_RELIABILITY
}

/**
 * 获取质量等级
 */
function getQualityGrade(score: number): DataQualityGrade {
  const { GRADE_THRESHOLDS } = DATA_QUALITY_CONFIG
  
  if (score >= GRADE_THRESHOLDS.A) return 'A'
  if (score >= GRADE_THRESHOLDS.B) return 'B'
  if (score >= GRADE_THRESHOLDS.C) return 'C'
  if (score >= GRADE_THRESHOLDS.D) return 'D'
  return 'F'
}

// ============================================
// 主要导出函数
// ============================================

/**
 * 计算数据质量分数
 * 
 * @param input 交易员数据
 * @returns 数据质量评估结果
 */
export function calculateDataQuality(input: DataQualityInput): DataQualityResult {
  const { WEIGHTS, FIELD_WEIGHTS } = DATA_QUALITY_CONFIG
  
  // 1. 计算字段完整性分数
  const missingFields: string[] = []
  let completenessRatio = 0
  
  const fields: Array<[keyof typeof FIELD_WEIGHTS, unknown]> = [
    ['roi', input.roi],
    ['pnl', input.pnl],
    ['winRate', input.winRate],
    ['maxDrawdown', input.maxDrawdown],
    ['followers', input.followers],
    ['tradesCount', input.tradesCount],
    ['copiers', input.copiers],
    ['aum', input.aum],
  ]
  
  for (const [fieldName, value] of fields) {
    if (isValidField(value)) {
      completenessRatio += FIELD_WEIGHTS[fieldName]
    } else {
      missingFields.push(fieldName)
    }
  }
  
  const completenessScore = completenessRatio * WEIGHTS.completeness
  
  // 2. 计算数据新鲜度分数
  const dataAgeHours = calculateDataAgeHours(input.capturedAt || input.updatedAt)
  const freshnessRatio = calculateFreshnessRatio(dataAgeHours)
  const freshnessScore = freshnessRatio * WEIGHTS.freshness
  
  // 3. 计算来源可靠性分数
  const reliabilityRatio = getPlatformReliability(input.source) / 100
  const reliabilityScore = reliabilityRatio * WEIGHTS.reliability
  
  // 4. 计算总分
  const totalScore = Math.round((completenessScore + freshnessScore + reliabilityScore) * 100) / 100
  
  // 5. 获取质量等级
  const qualityGrade = getQualityGrade(totalScore)
  
  return {
    totalScore,
    completenessScore: Math.round(completenessScore * 100) / 100,
    freshnessScore: Math.round(freshnessScore * 100) / 100,
    reliabilityScore: Math.round(reliabilityScore * 100) / 100,
    qualityGrade,
    missingFields,
    dataAgeHours: dataAgeHours !== null ? Math.round(dataAgeHours * 10) / 10 : null,
  }
}

/**
 * 批量计算数据质量分数
 */
export function calculateBatchDataQuality(
  inputs: DataQualityInput[]
): DataQualityResult[] {
  return inputs.map(calculateDataQuality)
}

/**
 * 计算数据质量加权的 Arena Score
 * 
 * 将数据质量分数作为 Arena Score 的权重因子，
 * 高质量数据的交易员排名更可靠。
 * 
 * @param arenaScore 原始 Arena Score
 * @param qualityScore 数据质量分数 (0-100)
 * @param qualityWeight 质量权重因子 (0-1)，默认 0.1
 * @returns 加权后的 Arena Score
 */
export function applyQualityWeight(
  arenaScore: number,
  qualityScore: number,
  qualityWeight: number = 0.1
): number {
  // 质量乘数：质量分 80+ 获得 1.0-1.1 倍加成
  // 质量分 50-80 获得 0.9-1.0 倍
  // 质量分 <50 获得 0.8-0.9 倍惩罚
  const qualityMultiplier = 0.8 + (qualityScore / 100) * 0.3
  
  // 按权重混合原始分数和加权分数
  const weightedScore = arenaScore * (1 - qualityWeight) + arenaScore * qualityMultiplier * qualityWeight
  
  return Math.round(Math.min(100, Math.max(0, weightedScore)) * 100) / 100
}

/**
 * 获取平台整体数据质量统计
 */
export function getPlatformQualityStats(
  results: DataQualityResult[]
): {
  avgScore: number
  gradeDistribution: Record<DataQualityGrade, number>
  commonMissingFields: Array<{ field: string; count: number; percentage: number }>
} {
  if (results.length === 0) {
    return {
      avgScore: 0,
      gradeDistribution: { A: 0, B: 0, C: 0, D: 0, F: 0 },
      commonMissingFields: [],
    }
  }
  
  // 计算平均分
  const avgScore = results.reduce((sum, r) => sum + r.totalScore, 0) / results.length
  
  // 统计等级分布
  const gradeDistribution: Record<DataQualityGrade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  for (const r of results) {
    gradeDistribution[r.qualityGrade]++
  }
  
  // 统计缺失字段
  const fieldCounts: Record<string, number> = {}
  for (const r of results) {
    for (const field of r.missingFields) {
      fieldCounts[field] = (fieldCounts[field] || 0) + 1
    }
  }
  
  const commonMissingFields = Object.entries(fieldCounts)
    .map(([field, count]) => ({
      field,
      count,
      percentage: Math.round((count / results.length) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count)
  
  return {
    avgScore: Math.round(avgScore * 100) / 100,
    gradeDistribution,
    commonMissingFields,
  }
}

// ============================================
// 数据新鲜度检查工具
// ============================================

/**
 * 检查数据是否过期
 */
export function isDataStale(
  capturedAt: string | Date | null | undefined,
  thresholdHours: number = 24
): boolean {
  const ageHours = calculateDataAgeHours(capturedAt)
  if (ageHours === null) return true
  return ageHours > thresholdHours
}

/**
 * 获取数据新鲜度状态
 */
export function getDataFreshnessStatus(
  capturedAt: string | Date | null | undefined
): 'fresh' | 'recent' | 'stale' | 'expired' | 'unknown' {
  const ageHours = calculateDataAgeHours(capturedAt)
  
  if (ageHours === null) return 'unknown'
  if (ageHours <= 4) return 'fresh'
  if (ageHours <= 24) return 'recent'
  if (ageHours <= 72) return 'stale'
  return 'expired'
}

/**
 * 格式化数据年龄为人类可读格式
 */
export function formatDataAge(
  capturedAt: string | Date | null | undefined,
  locale: 'en' | 'zh' = 'en'
): string {
  const ageHours = calculateDataAgeHours(capturedAt)
  
  if (ageHours === null) {
    return locale === 'zh' ? '未知' : 'Unknown'
  }
  
  if (ageHours < 1) {
    const minutes = Math.round(ageHours * 60)
    return locale === 'zh' ? `${minutes}分钟前` : `${minutes}m ago`
  }
  
  if (ageHours < 24) {
    const hours = Math.round(ageHours)
    return locale === 'zh' ? `${hours}小时前` : `${hours}h ago`
  }
  
  const days = Math.round(ageHours / 24)
  return locale === 'zh' ? `${days}天前` : `${days}d ago`
}
