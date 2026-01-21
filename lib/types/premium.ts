/**
 * 付费增值功能类型定义
 * 包含订阅计划、功能权限和 API 配额
 *
 * 核心付费价值：风险预警 + 数据透明
 *
 * 简化为双层会员体系：Free + Pro
 *
 * v2.0 精简版：从 13 个功能精简为 5 个核心功能
 * - trader_alerts: 交易员变动提醒 (核心)
 * - trader_comparison: 交易员对比 (核心)
 * - score_breakdown: 评分详情 + 百分位 (核心)
 * - historical_data: 历史数据 90天→1年 (扩展)
 * - api_access: API 访问 (技术用户)
 *
 * 已移除/免费化的功能：
 * - category_ranking → 免费
 * - pro_badge → 免费彩蛋
 * - premium_groups → 暂时保留但弱化
 * - portfolio_suggestions → 下线（合规风险）
 * - custom_rankings → 合并到 advanced_filter
 * - export_data → 无限制
 * - email/push_notifications → 合并到 trader_alerts
 */

// ============================================
// 订阅计划
// ============================================

export type SubscriptionTier = 'free' | 'pro'

/** 活跃订阅等级（不包含 free） */
export type ActiveSubscriptionTier = Exclude<SubscriptionTier, 'free'>

/**
 * 规范化订阅等级
 * 处理可能的无效值，返回有效的 SubscriptionTier
 */
export function normalizeSubscriptionTier(tier: string | null | undefined): SubscriptionTier {
  if (tier === 'pro') return 'pro'
  return 'free'
}

export interface SubscriptionPlan {
  id: SubscriptionTier
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
  tier: SubscriptionTier[]  // 哪些订阅等级包含此功能
  isCore?: boolean          // 是否为核心卖点
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
      '分类排行（合约/现货/链上）',  // v2.0: 免费化
      'Arena Score 子分数可见',       // v2.0: 免费化
      '基础交易员详情',
      '社区参与',
      '关注 10 个交易员',
      '7 天历史数据',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '不再错过异动，保护你的跟单收益',  // v2.0: 强调核心价值
    price: { monthly: 9.99, yearly: 99, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 1000,
      followLimit: 100,                     // v2.0: 从 50 提升到 100
      comparisonReportsPerMonth: -1,        // v2.0: 无限制（-1 表示无限）
      exportsPerMonth: -1,                  // v2.0: 无限制
      historicalDataDays: 365,              // v2.0: 从 90 天扩展到 1 年
      customRankingsLimit: 10,              // v2.0: 提升到 10
      emailNotificationsPerMonth: -1,       // v2.0: 无限制
      portfolioSuggestionsLimit: 0,         // v2.0: 已下线
    },
    badge: '推荐',
    recommended: true,
    highlights: [
      '🔔 交易员变动提醒（核心）',          // v2.0: 突出核心
      '📊 交易员对比（无限制）',
      '📈 评分详情 + 同类百分位',
      '📅 1 年历史数据',                    // v2.0: 从 90 天扩展
      '🔌 API 访问',
      '关注 100 个交易员',                  // v2.0: 从 50 提升
    ],
  },
]

// ============================================
// 功能列表（v2.0 精简版 - 按核心价值排序）
// ============================================

export const PREMIUM_FEATURES: PremiumFeature[] = [
  // ========== 核心 Pro 功能（5个）==========

  // 1. 交易员变动提醒 - 最核心卖点
  {
    id: 'trader_alerts',
    name: '交易员变动提醒',
    description: '关注的交易员排名、回撤大幅变动时自动通知（站内+邮件+推送）',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },

  // 2. 交易员对比
  {
    id: 'trader_comparison',
    name: '交易员对比',
    description: '最多 10 个交易员全维度对比分析',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },

  // 3. 评分详情 + 百分位（Pro 可见百分位，免费可见子分数）
  {
    id: 'score_breakdown',
    name: '评分详情',
    description: '查看 Arena Score 各项子分数和同类百分位排名',
    icon: '',
    tier: ['pro'],
    isCore: true,
  },

  // 4. 历史数据（扩展到 1 年）
  {
    id: 'historical_data',
    name: '历史数据',
    description: '访问长达 1 年的历史绩效数据（免费版仅 7 天）',
    icon: '',
    tier: ['pro'],
  },

  // 5. API 接口
  {
    id: 'api_access',
    name: 'API 接口',
    description: '程序化获取交易员数据，支持自定义监控',
    icon: '',
    tier: ['pro'],
  },

  // ========== 免费化/弱化的功能 ==========

  // 分类排行 - 改为免费
  {
    id: 'category_ranking',
    name: '分类排行',
    description: '按现货/合约/链上分类查看排行榜',
    icon: '',
    tier: ['free', 'pro'], // 改为免费可用
  },

  // 高级筛选（合并了 custom_rankings）
  {
    id: 'advanced_filter',
    name: '高级筛选',
    description: '多条件叠加筛选，保存筛选配置一键复用',
    icon: '',
    tier: ['pro'],
  },

  // 数据导出 - 改为无限制
  {
    id: 'export_data',
    name: '数据导出',
    description: '导出交易员数据为 CSV/Excel（无次数限制）',
    icon: '',
    tier: ['pro'],
  },

  // Pro 徽章 - 免费彩蛋
  {
    id: 'pro_badge',
    name: 'Pro 徽章',
    description: '主页头像显示 Pro 会员徽章（可在设置中关闭）',
    icon: '',
    tier: ['pro'],
  },

  // Pro 专属群组 - 保留但弱化
  {
    id: 'premium_groups',
    name: 'Pro 专属群组',
    description: '创建或加入会员专属群组',
    icon: '',
    tier: ['pro'],
  },

  // ========== 已下线/合并的功能 ==========

  // 邮件通知 - 合并到 trader_alerts
  {
    id: 'email_notifications',
    name: '邮件通知',
    description: '已合并到交易员变动提醒功能',
    icon: '',
    tier: ['pro'],
    isCore: false,
  },

  // 推送通知 - 合并到 trader_alerts
  {
    id: 'push_notifications',
    name: '即时推送',
    description: '已合并到交易员变动提醒功能',
    icon: '',
    tier: ['pro'],
    isCore: false,
  },

  // 自定义排行榜 - 合并到 advanced_filter
  {
    id: 'custom_rankings',
    name: '自定义排行榜',
    description: '已合并到高级筛选功能',
    icon: '',
    tier: ['pro'],
  },

  // 跟单组合建议 - 已下线（合规风险）
  {
    id: 'portfolio_suggestions',
    name: '跟单组合建议',
    description: '⚠️ 功能已下线 - 因合规风险暂停服务',
    icon: '',
    tier: [], // 空数组 = 所有人都不可用
  },
]

// ============================================
// v2.0 核心功能快捷访问
// ============================================

/** 获取 v2.0 核心 Pro 功能（5个） */
export function getCorePremiumFeatures(): PremiumFeature[] {
  const coreIds: PremiumFeatureId[] = [
    'trader_alerts',
    'trader_comparison',
    'score_breakdown',
    'historical_data',
    'api_access',
  ]
  return PREMIUM_FEATURES.filter(f => coreIds.includes(f.id))
}

/** 检查功能是否已下线 */
export function isFeatureDeprecated(featureId: PremiumFeatureId): boolean {
  const feature = PREMIUM_FEATURES.find(f => f.id === featureId)
  return feature ? feature.tier.length === 0 : true
}

// ============================================
// 工具函数
// ============================================

/**
 * 检查用户是否有某个功能的权限
 */
export function hasFeatureAccess(
  userTier: SubscriptionTier,
  featureId: PremiumFeatureId
): boolean {
  const feature = PREMIUM_FEATURES.find(f => f.id === featureId)
  if (!feature) return false
  return feature.tier.includes(userTier)
}

/**
 * 获取用户的功能限制
 */
export function getFeatureLimits(tier: SubscriptionTier): FeatureLimits {
  const plan = SUBSCRIPTION_PLANS.find(p => p.id === tier)
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
 */
export function getNewFeaturesForTier(tier: SubscriptionTier): PremiumFeature[] {
  const tierOrder: SubscriptionTier[] = ['free', 'pro']
  const currentIndex = tierOrder.indexOf(tier)
  
  if (currentIndex <= 0) {
    return PREMIUM_FEATURES.filter(f => f.tier.includes(tier))
  }
  
  const previousTier = tierOrder[currentIndex - 1]
  return PREMIUM_FEATURES.filter(
    f => f.tier.includes(tier) && !f.tier.includes(previousTier)
  )
}
