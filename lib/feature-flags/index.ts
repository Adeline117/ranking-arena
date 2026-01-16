/**
 * 功能开关系统
 * 支持环境变量、用户百分比、特定用户白名单
 */

// ============================================
// 类型定义
// ============================================

/**
 * 功能开关名称
 */
export const FeatureFlags = {
  // UI 功能
  NEW_TRADER_UI: 'new_trader_ui',
  DARK_MODE_V2: 'dark_mode_v2',
  NEW_POST_EDITOR: 'new_post_editor',
  
  // API 功能
  API_V2: 'api_v2',
  ENHANCED_SEARCH: 'enhanced_search',
  
  // 实验性功能
  AI_RECOMMENDATIONS: 'ai_recommendations',
  SOCIAL_TRADING: 'social_trading',
  
  // 业务功能
  PREMIUM_FEATURES: 'premium_features',
  NOTIFICATIONS_V2: 'notifications_v2',
} as const

export type FeatureFlagName = typeof FeatureFlags[keyof typeof FeatureFlags]

/**
 * 功能开关配置
 */
export interface FeatureFlagConfig {
  /** 是否默认启用 */
  defaultEnabled: boolean
  /** 启用百分比 (0-100) */
  percentage?: number
  /** 启用的用户 ID 列表（白名单） */
  enabledUserIds?: string[]
  /** 禁用的用户 ID 列表（黑名单） */
  disabledUserIds?: string[]
  /** 环境变量名称 */
  envVar?: string
  /** 启用的环境（development, production, test） */
  enabledEnvironments?: string[]
  /** 描述 */
  description?: string
}

/**
 * 功能开关配置映射
 */
export const FEATURE_FLAG_CONFIGS: Record<FeatureFlagName, FeatureFlagConfig> = {
  [FeatureFlags.NEW_TRADER_UI]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_NEW_TRADER_UI',
    description: '新版交易员页面 UI',
  },
  [FeatureFlags.DARK_MODE_V2]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_DARK_MODE_V2',
    description: '深色模式 V2',
  },
  [FeatureFlags.NEW_POST_EDITOR]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_NEW_POST_EDITOR',
    description: '新版帖子编辑器',
  },
  [FeatureFlags.API_V2]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_API_V2',
    description: 'API V2',
    enabledEnvironments: ['development'],
  },
  [FeatureFlags.ENHANCED_SEARCH]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_ENHANCED_SEARCH',
    description: '增强搜索功能',
  },
  [FeatureFlags.AI_RECOMMENDATIONS]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_AI_RECOMMENDATIONS',
    description: 'AI 推荐系统',
  },
  [FeatureFlags.SOCIAL_TRADING]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_SOCIAL_TRADING',
    description: '社交交易功能',
  },
  [FeatureFlags.PREMIUM_FEATURES]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_PREMIUM_FEATURES',
    description: '付费功能',
  },
  [FeatureFlags.NOTIFICATIONS_V2]: {
    defaultEnabled: false,
    percentage: 0,
    envVar: 'NEXT_PUBLIC_FF_NOTIFICATIONS_V2',
    description: '通知系统 V2',
  },
}

// ============================================
// 核心功能
// ============================================

/**
 * 生成用户的稳定随机数 (0-100)
 * 用于百分比发布
 */
function getUserPercentile(userId: string, flagName: string): number {
  // 使用简单的哈希算法生成稳定的伪随机数
  const str = `${userId}:${flagName}`
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash) % 100
}

/**
 * 检查功能开关是否启用
 */
export function isFeatureEnabled(
  flagName: FeatureFlagName,
  options: {
    userId?: string
    environment?: string
  } = {}
): boolean {
  const config = FEATURE_FLAG_CONFIGS[flagName]
  if (!config) {
    console.warn(`[FeatureFlags] Unknown flag: ${flagName}`)
    return false
  }

  const { userId, environment = process.env.NODE_ENV } = options

  // 1. 检查环境变量（最高优先级）
  if (config.envVar) {
    const envValue = process.env[config.envVar]
    if (envValue !== undefined) {
      return envValue === 'true' || envValue === '1'
    }
  }

  // 2. 检查环境限制
  if (config.enabledEnvironments && config.enabledEnvironments.length > 0) {
    if (!config.enabledEnvironments.includes(environment || 'production')) {
      return false
    }
  }

  // 3. 检查用户黑名单
  if (userId && config.disabledUserIds?.includes(userId)) {
    return false
  }

  // 4. 检查用户白名单
  if (userId && config.enabledUserIds?.includes(userId)) {
    return true
  }

  // 5. 检查百分比发布
  if (config.percentage !== undefined && config.percentage > 0) {
    if (userId) {
      const percentile = getUserPercentile(userId, flagName)
      return percentile < config.percentage
    }
    // 无用户 ID 时，根据百分比随机决定
    return Math.random() * 100 < config.percentage
  }

  // 6. 返回默认值
  return config.defaultEnabled
}

/**
 * 获取所有功能开关状态
 */
export function getAllFeatureFlags(
  options: {
    userId?: string
    environment?: string
  } = {}
): Record<FeatureFlagName, boolean> {
  const flags = {} as Record<FeatureFlagName, boolean>
  
  for (const flag of Object.values(FeatureFlags)) {
    flags[flag] = isFeatureEnabled(flag, options)
  }
  
  return flags
}

/**
 * 获取功能开关配置
 */
export function getFeatureFlagConfig(flagName: FeatureFlagName): FeatureFlagConfig | null {
  return FEATURE_FLAG_CONFIGS[flagName] || null
}

// ============================================
// 运行时配置更新（用于远程配置）
// ============================================

/**
 * 运行时功能开关覆盖
 * 可以通过远程配置动态更新
 */
let runtimeOverrides: Partial<Record<FeatureFlagName, boolean>> = {}

/**
 * 设置运行时覆盖
 */
export function setFeatureFlagOverride(flagName: FeatureFlagName, enabled: boolean): void {
  runtimeOverrides[flagName] = enabled
}

/**
 * 清除运行时覆盖
 */
export function clearFeatureFlagOverride(flagName: FeatureFlagName): void {
  delete runtimeOverrides[flagName]
}

/**
 * 清除所有运行时覆盖
 */
export function clearAllFeatureFlagOverrides(): void {
  runtimeOverrides = {}
}

/**
 * 检查功能开关是否启用（包含运行时覆盖）
 */
export function isFeatureEnabledWithOverrides(
  flagName: FeatureFlagName,
  options: {
    userId?: string
    environment?: string
  } = {}
): boolean {
  // 检查运行时覆盖
  if (flagName in runtimeOverrides) {
    return runtimeOverrides[flagName]!
  }
  
  return isFeatureEnabled(flagName, options)
}
