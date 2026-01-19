/**
 * 数据质量验证工具（ESM 版本）
 * 用于验证爬虫抓取的交易员数据质量
 */

/**
 * 默认验证配置
 */
export const DEFAULT_VALIDATION_CONFIG = {
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
 */
export const PLATFORM_VALIDATION_CONFIGS = {
  binance_futures: {
    minTopRoi: 500,
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
    minCount: 15,  // Bitget Spot 页面数据较少
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
    minCount: 15,  // OKX Web3 页面数据较少
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
export function getValidationConfig(platform) {
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
      ...DEFAULT_VALIDATION_CONFIG.roiRange,
      ...(platformOverride.roiRange || {}),
    },
  }
}

/**
 * 验证交易员数据
 * @param {Array} traders - 交易员数据数组
 * @param {Object} config - 验证配置覆盖
 * @param {string} platform - 平台名称
 * @returns {Object} 验证结果
 */
export function validateTraderData(traders, config = {}, platform) {
  const finalConfig = {
    ...getValidationConfig(platform),
    ...config,
  }
  
  const errors = []
  const warnings = []
  
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
      r => r < finalConfig.roiRange.min || r > finalConfig.roiRange.max
    ).length
    
    if (outOfRangeCount > 0) {
      warnings.push(`有 ${outOfRangeCount} 条数据 ROI 超出合理范围 [${finalConfig.roiRange.min}, ${finalConfig.roiRange.max}]`)
    }
  }
  
  // 6. traderId 格式检查
  const invalidIds = traders.filter(t => !t.traderId || String(t.traderId).trim() === '')
  if (invalidIds.length > 0) {
    errors.push(`有 ${invalidIds.length} 条数据缺少有效的 traderId`)
  }
  
  const valid = errors.length === 0
  
  return {
    valid,
    warnings,
    errors,
    stats,
  }
}

/**
 * 去重交易员数据
 */
export function deduplicateTraders(traders) {
  const seen = new Set()
  return traders.filter(t => {
    if (seen.has(t.traderId)) {
      return false
    }
    seen.add(t.traderId)
    return true
  })
}

/**
 * 打印验证结果
 */
export function printValidationResult(result, platform) {
  const { valid, warnings, errors, stats } = result
  
  console.log(`\n📊 数据验证结果 (${platform || '未知平台'}):`)
  console.log(`   总数: ${stats.totalCount}`)
  console.log(`   去重后: ${stats.uniqueCount}`)
  console.log(`   TOP ROI: ${stats.topRoi.toFixed(2)}%`)
  console.log(`   平均 ROI: ${stats.avgRoi.toFixed(2)}%`)
  console.log(`   昵称覆盖率: ${(stats.nicknameRate * 100).toFixed(1)}%`)
  
  if (errors.length > 0) {
    console.log('\n❌ 错误:')
    errors.forEach(e => console.log(`   - ${e}`))
  }
  
  if (warnings.length > 0) {
    console.log('\n⚠️ 警告:')
    warnings.forEach(w => console.log(`   - ${w}`))
  }
  
  if (valid) {
    console.log('\n✅ 数据验证通过')
  } else {
    console.log('\n❌ 数据验证失败')
  }
  
  return valid
}
