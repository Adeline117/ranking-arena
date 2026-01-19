/**
 * 功能开关配置
 * 用于 MVP 阶段精简功能，控制功能入口的显示/隐藏
 * 
 * 设计原则：
 * - 核心功能默认开启
 * - 次要功能可配置隐藏
 * - 实验性功能默认关闭
 */

export interface FeatureFlags {
  // ============================================
  // 核心功能（默认开启）
  // ============================================
  
  /** 排行榜功能 */
  ranking: boolean
  /** 交易员详情页 */
  traderDetail: boolean
  /** 用户评价系统 */
  reviews: boolean
  /** 用户收藏/关注 */
  favorites: boolean
  /** 组合建议 - 标记为 Beta */
  portfolioSuggestions: boolean
  /** 交易员认领 - 仅后台审核 */
  traderClaim: boolean
  /** 避雷榜/风险提示 */
  avoidList: boolean
  
  // ============================================
  // 实验性功能（默认关闭）
  // ============================================
  
  /** AI 组合推荐 */
  aiPortfolio: boolean
  /** 交易员私信 */
  traderMessaging: boolean
  /** 社交功能（关注用户、动态等）*/
  socialFeatures: boolean
  
  // ============================================
  // 开发/调试功能
  // ============================================
  
  /** 显示调试信息 */
  debugMode: boolean
  /** 显示功能标签（Beta、New 等）*/
  showFeatureBadges: boolean
}

/**
 * 默认功能开关配置
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  // 核心功能
  ranking: true,
  traderDetail: true,
  reviews: true,
  favorites: true,
  portfolioSuggestions: true, // 显示但标记 Beta
  traderClaim: false,         // 仅后台审核
  avoidList: true,            // 改名为"风险提示"后开启
  
  // 实验性功能
  aiPortfolio: false,
  traderMessaging: false,
  socialFeatures: false,
  
  // 开发功能
  debugMode: process.env.NODE_ENV === 'development',
  showFeatureBadges: true,
}

/**
 * 功能元信息（用于 UI 展示）
 */
export const FEATURE_META: Record<keyof FeatureFlags, {
  name: string
  description: string
  badge?: 'beta' | 'new' | 'coming_soon' | 'premium'
  tier?: 'free' | 'pro' | 'elite'
}> = {
  ranking: {
    name: '排行榜',
    description: '跨交易所交易员排名',
  },
  traderDetail: {
    name: '交易员详情',
    description: '查看交易员详细数据和历史',
  },
  reviews: {
    name: '用户评价',
    description: '查看和发布交易员评价',
  },
  favorites: {
    name: '收藏关注',
    description: '收藏和关注交易员',
  },
  portfolioSuggestions: {
    name: '组合建议',
    description: '智能组合推荐',
    badge: 'beta',
    tier: 'pro',
  },
  traderClaim: {
    name: '交易员认领',
    description: '交易员认领和认证',
    badge: 'coming_soon',
  },
  avoidList: {
    name: '风险提示',
    description: '社区风险预警',
  },
  aiPortfolio: {
    name: 'AI 组合',
    description: 'AI 驱动的组合优化',
    badge: 'coming_soon',
    tier: 'elite',
  },
  traderMessaging: {
    name: '交易员私信',
    description: '与认证交易员私信交流',
    badge: 'coming_soon',
    tier: 'elite',
  },
  socialFeatures: {
    name: '社交功能',
    description: '关注用户、查看动态',
    badge: 'coming_soon',
  },
  debugMode: {
    name: '调试模式',
    description: '显示调试信息',
  },
  showFeatureBadges: {
    name: '功能标签',
    description: '显示 Beta、New 等标签',
  },
}

// ============================================
// 运行时功能开关
// ============================================

let runtimeFlags: FeatureFlags = { ...DEFAULT_FEATURE_FLAGS }

/**
 * 获取当前功能开关配置
 */
export function getFeatureFlags(): FeatureFlags {
  return runtimeFlags
}

/**
 * 检查某个功能是否启用
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  return runtimeFlags[feature]
}

/**
 * 更新功能开关（运行时）
 */
export function setFeatureFlags(flags: Partial<FeatureFlags>): void {
  runtimeFlags = { ...runtimeFlags, ...flags }
}

/**
 * 重置为默认配置
 */
export function resetFeatureFlags(): void {
  runtimeFlags = { ...DEFAULT_FEATURE_FLAGS }
}

/**
 * 从环境变量加载功能开关
 * 环境变量格式: FEATURE_FLAG_XXX=true/false
 */
export function loadFeatureFlagsFromEnv(): void {
  const envFlags: Partial<FeatureFlags> = {}
  
  Object.keys(DEFAULT_FEATURE_FLAGS).forEach((key) => {
    const envKey = `FEATURE_FLAG_${key.toUpperCase()}`
    const envValue = process.env[envKey]
    
    if (envValue !== undefined) {
      envFlags[key as keyof FeatureFlags] = envValue === 'true'
    }
  })
  
  setFeatureFlags(envFlags)
}

// 在模块加载时自动从环境变量加载
if (typeof process !== 'undefined') {
  loadFeatureFlagsFromEnv()
}
