/**
 * 付费增值功能类型定义
 * 包含订阅计划、功能权限和 API 配额
 *
 * 核心付费价值：风险预警系统
 *
 * 简化为双层会员体系：Free + Pro
 * 支持旧版 elite/enterprise 等级以保证向后兼容
 */

// ============================================
// 订阅计划
// ============================================

/** 当前活跃的订阅等级 */
export type ActiveSubscriptionTier = 'free' | 'pro'

/**
 * 完整订阅等级（包含旧版等级以保证向后兼容）
 * - free: 免费版
 * - pro: 专业版
 * - elite: 旧版精英版（映射到 pro）
 * - enterprise: 旧版企业版（映射到 pro）
 */
export type SubscriptionTier = 'free' | 'pro' | 'elite' | 'enterprise'

/**
 * 将旧版订阅等级映射到当前等级
 */
export function normalizeSubscriptionTier(tier: SubscriptionTier | string | null | undefined): ActiveSubscriptionTier {
  if (!tier) return 'free'
  if (tier === 'elite' || tier === 'enterprise' || tier === 'pro') return 'pro'
  return 'free'
}

export interface SubscriptionPlan {
  id: ActiveSubscriptionTier
  name: string
  description: string
  price: {
    monthly: number
    yearly: number
    currency: string
  }
  features: PremiumFeature[]
  limits: FeatureLimits
  badge?: string
  recommended?: boolean
  highlights: string[]  // 核心卖点
}

// ============================================
// 功能定义
// ============================================

export type PremiumFeatureId = 
  | 'email_notifications'     // 邮件通知
  | 'push_notifications'      // 推送通知
  | 'portfolio_suggestions'   // 跟单组合建议
  | 'trader_comparison'       // 交易员对比报告
  | 'api_access'              // API 接口访问
  | 'custom_rankings'         // 自定义排行榜
  | 'export_data'             // 数据导出
  | 'historical_data'         // 历史数据访问
  | 'category_ranking'        // 分类排行
  | 'trader_alerts'           // 交易员变动提醒
  | 'score_breakdown'         // 评分详情
  | 'pro_badge'               // Pro 徽章
  | 'advanced_filter'         // 高级筛选
  | 'premium_groups'          // Pro 专属群组

export interface PremiumFeature {
  id: PremiumFeatureId
  name: string
  description: string
  icon: string
  tier: ActiveSubscriptionTier[]  // 哪些订阅等级包含此功能
  isCore?: boolean                // 是否为核心卖点
}

export interface FeatureLimits {
  /** 每日 API 调用次数 */
  apiCallsPerDay: number
  /** 可关注的交易员数量 */
  followLimit: number
  /** 可创建的对比报告数量（每月） */
  comparisonReportsPerMonth: number
  /** 数据导出次数（每月） */
  exportsPerMonth: number
  /** 历史数据天数 */
  historicalDataDays: number
  /** 自定义排行榜数量 */
  customRankingsLimit: number
  /** 邮件通知额度（每月） */
  emailNotificationsPerMonth: number
  /** 跟单组合数量 */
  portfolioSuggestionsLimit: number
}

// ============================================
// 预定义计划（以风险预警为核心卖点）
// ============================================

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'free',
    name: '免费版',
    description: '体验基础功能，了解平台价值',
    price: { monthly: 0, yearly: 0, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 0,
      followLimit: 10,
      comparisonReportsPerMonth: 0,
      exportsPerMonth: 0,
      historicalDataDays: 7,
      customRankingsLimit: 0,
      emailNotificationsPerMonth: 0,
      portfolioSuggestionsLimit: 0,
    },
    highlights: [
      '排行榜完整浏览',
      '基础交易员详情',
      '社区参与（每日3条帖子）',
      '关注10个交易员',
      '7天历史数据',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '专业风险管理，保护你的跟单收益',
    price: { monthly: 9.99, yearly: 99, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 1000,
      followLimit: 50,
      comparisonReportsPerMonth: 10,
      exportsPerMonth: 10,
      historicalDataDays: 90,
      customRankingsLimit: 3,
      emailNotificationsPerMonth: 100,
      portfolioSuggestionsLimit: 3,
    },
    badge: '推荐',
    recommended: true,
    highlights: [
      '分类排行 + 高级筛选',
      'Arena Score 详情分解',
      '交易员变动提醒',
      '交易员对比（每月10次）',
      '90天历史数据',
      '数据导出（每月10次）',
      'Pro 徽章',
      'Pro 专属群组',
    ],
  },
]

// ============================================
// 功能列表（按核心价值排序）
// ============================================

export const PREMIUM_FEATURES: PremiumFeature[] = [
  // 通知功能
  {
    id: 'email_notifications',
    name: '邮件通知',
    description: '重要信息通过邮件及时推送',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },
  {
    id: 'push_notifications',
    name: '即时推送',
    description: '移动端即时推送',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },
  
  // 组合建议
  {
    id: 'portfolio_suggestions',
    name: '跟单组合建议',
    description: '智能推荐分散风险的交易员组合',
    icon: '',
    tier: ['pro'],
  },
  
  // 数据分析
  {
    id: 'trader_comparison',
    name: '交易员对比',
    description: '多维度对比分析交易员表现',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'historical_data',
    name: '历史数据',
    description: '访问更长时间跨度的历史绩效（90天）',
    icon: '',
    tier: ['pro'],
  },
  
  // 高级功能
  {
    id: 'custom_rankings',
    name: '自定义排行榜',
    description: '创建专属的筛选排行榜',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'export_data',
    name: '数据导出',
    description: '导出交易员数据为 CSV/Excel',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'api_access',
    name: 'API 接口',
    description: '通过 API 获取数据',
    icon: '',
    tier: ['pro'],
  },
  
  // Pro 核心功能
  {
    id: 'category_ranking',
    name: '分类排行',
    description: '按现货/合约/链上分类查看排行榜',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'trader_alerts',
    name: '交易员变动提醒',
    description: '关注的交易员大幅变动时自动提醒',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },
  {
    id: 'score_breakdown',
    name: '评分详情',
    description: '查看 Arena Score 各项子分数和同类分位',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'pro_badge',
    name: 'Pro 徽章',
    description: '主页头像显示 Pro 会员徽章',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'advanced_filter',
    name: '高级筛选',
    description: '多条件叠加筛选，保存筛选配置一键复用',
    icon: '',
    tier: ['pro'],
  },
  {
    id: 'premium_groups',
    name: 'Pro 专属群组',
    description: '创建或加入会员专属群组',
    icon: '',
    tier: ['pro'],
  },
]

// ============================================
// 工具函数
// ============================================

/**
 * 检查用户是否有某个功能的权限
 * 支持旧版 elite/enterprise 等级（映射到 pro）
 */
export function hasFeatureAccess(
  userTier: SubscriptionTier,
  featureId: PremiumFeatureId
): boolean {
  const feature = PREMIUM_FEATURES.find(f => f.id === featureId)
  if (!feature) return false
  const normalizedTier = normalizeSubscriptionTier(userTier)
  return feature.tier.includes(normalizedTier)
}

/**
 * 获取用户的功能限制
 * 支持旧版 elite/enterprise 等级（映射到 pro）
 */
export function getFeatureLimits(tier: SubscriptionTier): FeatureLimits {
  const normalizedTier = normalizeSubscriptionTier(tier)
  const plan = SUBSCRIPTION_PLANS.find(p => p.id === normalizedTier)
  return plan?.limits || SUBSCRIPTION_PLANS[0].limits
}

/**
 * 格式化价格显示
 */
export function formatPrice(price: number, currency: string = 'USD'): string {
  if (price === -1) return '联系销售'
  if (price === 0) return '免费'
  return `$${price}/${currency === 'USD' ? 'mo' : currency}`
}

/**
 * 获取核心功能列表
 */
export function getCoreFeatures(): PremiumFeature[] {
  return PREMIUM_FEATURES.filter(f => f.isCore)
}

/**
 * 获取某等级的新功能（相比上一等级）
 * 支持旧版 elite/enterprise 等级（映射到 pro）
 */
export function getNewFeaturesForTier(tier: SubscriptionTier): PremiumFeature[] {
  const tierOrder: ActiveSubscriptionTier[] = ['free', 'pro']
  const normalizedTier = normalizeSubscriptionTier(tier)
  const currentIndex = tierOrder.indexOf(normalizedTier)

  if (currentIndex <= 0) {
    return PREMIUM_FEATURES.filter(f => f.tier.includes(normalizedTier))
  }

  const previousTier = tierOrder[currentIndex - 1]
  return PREMIUM_FEATURES.filter(
    f => f.tier.includes(normalizedTier) && !f.tier.includes(previousTier)
  )
}
