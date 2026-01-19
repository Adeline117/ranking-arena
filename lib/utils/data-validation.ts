/**
 * 数据质量验证工具
 * 用于验证爬虫抓取的交易员数据质量
 */

import { createLogger } from './logger'

const logger = createLogger('data-validation')

/**
 * 交易员数据类型（与爬虫脚本保持一致）
 */
export interface TraderData {
  traderId: string
  nickname?: string | null
  avatar?: string | null
  roi: number
  pnl?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  followers?: number | null
  aum?: number | null
  tradesCount?: number | null
  rank?: number
}

/**
 * 验证配置
 */
export interface ValidationConfig {
  /** 最少交易员数量 */
  minCount: number
  /** TOP1 最低 ROI（百分比） */
  minTopRoi: number
  /** 最大重复率（0-1） */
  maxDuplicateRate: number
  /** 最小有效昵称比例（0-1） */
  minNicknameRate: number
  /** ROI 合理范围检查 */
  roiRange?: {
    min: number
    max: number
  }
  /** 是否允许负 ROI */
  allowNegativeRoi?: boolean
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否通过验证 */
  valid: boolean
  /** 警告信息（不影响有效性） */
  warnings: string[]
  /** 错误信息（导致验证失败） */
  errors: string[]
  /** 统计信息 */
  stats: {
    totalCount: number
    uniqueCount: number
    duplicateCount: number
    duplicateRate: number
    withNickname: number
    nicknameRate: number
    topRoi: number
    avgRoi: number
    positiveRoiCount: number
    negativeRoiCount: number
  }
}

/**
 * 默认验证配置
 */
export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  minCount: 50,
  minTopRoi: 100, // TOP1 至少 100% ROI
  maxDuplicateRate: 0.1, // 最多 10% 重复
  minNicknameRate: 0.5, // 至少 50% 有昵称
  roiRange: {
    min: -100,
    max: 100000, // 100,000% 作为异常值上限
  },
  allowNegativeRoi: true,
}

/**
 * 各平台的验证配置覆盖
 * 根据不同平台的数据特点调整阈值
 */
export const PLATFORM_VALIDATION_CONFIGS: Record<string, Partial<ValidationConfig>> = {
  binance_futures: {
    minTopRoi: 500, // Binance 合约 TOP1 通常 ROI 很高
    minCount: 80,
  },
  binance_spot: {
    minTopRoi: 200,
    minCount: 60,
  },
  binance_web3: {
    minTopRoi: 100,
    minCount: 30,
  },
  bybit: {
    minTopRoi: 300,
    minCount: 60,
  },
  bitget_futures: {
    minTopRoi: 300,
    minCount: 60,
  },
  bitget_spot: {
    minTopRoi: 100,
    minCount: 40,
  },
  mexc: {
    minTopRoi: 100,
    minCount: 30,
  },
  coinex: {
    minTopRoi: 50,
    minCount: 20,
  },
  okx_web3: {
    minTopRoi: 50,
    minCount: 20,
  },
  kucoin: {
    minTopRoi: 100,
    minCount: 30,
  },
  gmx: {
    minTopRoi: 50,
    minCount: 10,
  },
}

/**
 * 获取平台的验证配置
 */
export function getValidationConfig(platform?: string): ValidationConfig {
  if (!platform) {
    return DEFAULT_VALIDATION_CONFIG
  }
  
  const platformOverride = PLATFORM_VALIDATION_CONFIGS[platform]
  if (!platformOverride) {
    return DEFAULT_VALIDATION_CONFIG
  }
  
  return {
    ...DEFAULT_VALIDATION_CONFIG,
    ...platformOverride,
    roiRange: {
      ...DEFAULT_VALIDATION_CONFIG.roiRange!,
      ...platformOverride.roiRange,
    },
  }
}

/**
 * 验证交易员数据
 */
export function validateTraderData(
  traders: TraderData[],
  config: Partial<ValidationConfig> = {},
  platform?: string
): ValidationResult {
  const finalConfig = {
    ...getValidationConfig(platform),
    ...config,
  }
  
  const errors: string[] = []
  const warnings: string[] = []
  
  // 计算统计数据
  const totalCount = traders.length
  const uniqueIds = new Set(traders.map(t => t.traderId))
  const uniqueCount = uniqueIds.size
  const duplicateCount = totalCount - uniqueCount
  const duplicateRate = totalCount > 0 ? duplicateCount / totalCount : 0
  
  const withNickname = traders.filter(t => t.nickname && t.nickname.trim() !== '').length
  const nicknameRate = totalCount > 0 ? withNickname / totalCount : 0
  
  const rois = traders.map(t => t.roi).filter(r => typeof r === 'number' && !isNaN(r))
  const topRoi = rois.length > 0 ? Math.max(...rois) : 0
  const avgRoi = rois.length > 0 ? rois.reduce((a, b) => a + b, 0) / rois.length : 0
  
  const positiveRoiCount = rois.filter(r => r > 0).length
  const negativeRoiCount = rois.filter(r => r < 0).length
  
  const stats = {
    totalCount,
    uniqueCount,
    duplicateCount,
    duplicateRate,
    withNickname,
    nicknameRate,
    topRoi,
    avgRoi,
    positiveRoiCount,
    negativeRoiCount,
  }
  
  // 验证规则
  
  // 1. 数量检查
  if (totalCount === 0) {
    errors.push('数据为空，没有获取到任何交易员')
  } else if (totalCount < finalConfig.minCount) {
    errors.push(`交易员数量不足: ${totalCount} < ${finalConfig.minCount}`)
  }
  
  // 2. 重复率检查
  if (duplicateRate > finalConfig.maxDuplicateRate) {
    errors.push(`重复率过高: ${(duplicateRate * 100).toFixed(1)}% > ${(finalConfig.maxDuplicateRate * 100).toFixed(1)}%`)
  } else if (duplicateCount > 0) {
    warnings.push(`存在 ${duplicateCount} 条重复数据 (${(duplicateRate * 100).toFixed(1)}%)`)
  }
  
  // 3. TOP ROI 检查
  if (topRoi < finalConfig.minTopRoi) {
    errors.push(`TOP1 ROI 过低: ${topRoi.toFixed(2)}% < ${finalConfig.minTopRoi}%，数据可能有问题`)
  }
  
  // 4. 昵称率检查
  if (nicknameRate < finalConfig.minNicknameRate) {
    warnings.push(`昵称覆盖率低: ${(nicknameRate * 100).toFixed(1)}% < ${(finalConfig.minNicknameRate * 100).toFixed(1)}%`)
  }
  
  // 5. ROI 范围检查
  if (finalConfig.roiRange) {
    const outOfRangeCount = rois.filter(
      r => r < finalConfig.roiRange!.min || r > finalConfig.roiRange!.max
    ).length
    
    if (outOfRangeCount > 0) {
      warnings.push(`有 ${outOfRangeCount} 条数据 ROI 超出合理范围 [${finalConfig.roiRange.min}, ${finalConfig.roiRange.max}]`)
    }
  }
  
  // 6. 负 ROI 检查
  if (!finalConfig.allowNegativeRoi && negativeRoiCount > 0) {
    warnings.push(`有 ${negativeRoiCount} 条数据 ROI 为负值`)
  }
  
  // 7. traderId 格式检查
  const invalidIds = traders.filter(t => !t.traderId || t.traderId.trim() === '')
  if (invalidIds.length > 0) {
    errors.push(`有 ${invalidIds.length} 条数据缺少有效的 traderId`)
  }
  
  const valid = errors.length === 0
  
  // 记录日志
  if (!valid) {
    logger.warn('数据验证失败', { 
      platform, 
      errors, 
      warnings, 
      stats: { totalCount, topRoi, duplicateRate } 
    })
  } else if (warnings.length > 0) {
    logger.info('数据验证通过（有警告）', { 
      platform, 
      warnings, 
      stats: { totalCount, topRoi } 
    })
  }
  
  return {
    valid,
    warnings,
    errors,
    stats,
  }
}

/**
 * 去重交易员数据
 * 保留每个 traderId 的第一条记录（通常是排名最高的）
 */
export function deduplicateTraders(traders: TraderData[]): TraderData[] {
  const seen = new Set<string>()
  return traders.filter(t => {
    if (seen.has(t.traderId)) {
      return false
    }
    seen.add(t.traderId)
    return true
  })
}

/**
 * 清理和标准化交易员数据
 */
export function sanitizeTraderData(trader: TraderData): TraderData {
  return {
    ...trader,
    traderId: String(trader.traderId).trim(),
    nickname: trader.nickname?.trim() || null,
    avatar: trader.avatar?.trim() || null,
    roi: typeof trader.roi === 'number' ? trader.roi : parseFloat(String(trader.roi)) || 0,
    pnl: trader.pnl != null ? parseFloat(String(trader.pnl)) : null,
    winRate: trader.winRate != null ? parseFloat(String(trader.winRate)) : null,
    maxDrawdown: trader.maxDrawdown != null ? parseFloat(String(trader.maxDrawdown)) : null,
    followers: trader.followers != null ? parseInt(String(trader.followers), 10) : null,
    aum: trader.aum != null ? parseFloat(String(trader.aum)) : null,
    tradesCount: trader.tradesCount != null ? parseInt(String(trader.tradesCount), 10) : null,
  }
}

/**
 * 处理交易员数据：清理、去重、验证
 * 返回处理后的数据和验证结果
 */
export function processTraderData(
  traders: TraderData[],
  platform?: string,
  config?: Partial<ValidationConfig>
): {
  data: TraderData[]
  validation: ValidationResult
} {
  // 1. 清理数据
  const sanitized = traders.map(sanitizeTraderData)
  
  // 2. 去重
  const deduplicated = deduplicateTraders(sanitized)
  
  // 3. 按 ROI 排序
  deduplicated.sort((a, b) => (b.roi || 0) - (a.roi || 0))
  
  // 4. 更新排名
  deduplicated.forEach((t, idx) => {
    t.rank = idx + 1
  })
  
  // 5. 验证
  const validation = validateTraderData(deduplicated, config, platform)
  
  return {
    data: deduplicated,
    validation,
  }
}
