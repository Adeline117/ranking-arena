/**
 * 付费增值功能类型定义
 * 包含订阅计划、功能权限和 API 配额
 * 
 * 核心付费价值：风险预警系统
 */

// ============================================
// 订阅计划
// ============================================

export type SubscriptionTier = 'free' | 'pro' | 'elite' | 'enterprise'

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
  | 'basic_alerts'            // 基础告警（免费用户）
  | 'advanced_alerts'         // 高级告警（回撤、胜率、跟单者撤离等）
  | 'email_notifications'     // 邮件通知
  | 'push_notifications'      // 推送通知
  | 'custom_thresholds'       // 自定义告警阈值
  | 'profit_loss_targets'     // 止盈止损提醒
  | 'portfolio_suggestions'   // 跟单组合建议
  | 'ai_portfolio'            // AI 智能组合
  | 'trader_comparison'       // 交易员对比报告
  | 'api_access'              // API 接口访问
  | 'portfolio_tracking'      // 投资组合追踪
  | 'custom_rankings'         // 自定义排行榜
  | 'export_data'             // 数据导出
  | 'historical_data'         // 历史数据访问
  | 'risk_analysis'           // 风险分析报告
  | 'strategy_backtest'       // 策略回测
  | 'priority_support'        // 优先客服支持
  | 'trader_messaging'        // 交易员私信
  | 'white_label'             // 白标定制

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
  /** 风险预警交易员数量（核心限制） */
  alertsLimit: number
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
      alertsLimit: 3,                    // 免费用户：最多监控 3 个交易员
      emailNotificationsPerMonth: 0,     // 无邮件通知
      portfolioSuggestionsLimit: 0,      // 无组合建议
    },
    highlights: [
      '排行榜完整浏览',
      '社区讨论参与',
      '监控 3 个交易员',
      '应用内告警通知',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '专业风险管理，保护你的跟单收益',
    price: { monthly: 9.9, yearly: 99, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 1000,
      followLimit: 50,
      comparisonReportsPerMonth: 10,
      exportsPerMonth: 10,
      historicalDataDays: 90,
      customRankingsLimit: 3,
      alertsLimit: 20,                   // Pro：监控 20 个交易员
      emailNotificationsPerMonth: 100,   // 每月 100 封邮件通知
      portfolioSuggestionsLimit: 3,      // 基础组合建议
    },
    badge: '最受欢迎',
    recommended: true,
    highlights: [
      '监控 20 个交易员',
      '邮件 + 推送通知',
      '自定义止盈止损',
      '回撤急剧加深预警',
      '胜率下降预警',
      '基础组合建议',
      '90 天历史数据',
    ],
  },
  {
    id: 'elite',
    name: 'Elite',
    description: '极致风控体验，专业投资者首选',
    price: { monthly: 29.9, yearly: 299, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 10000,
      followLimit: 200,
      comparisonReportsPerMonth: 50,
      exportsPerMonth: 50,
      historicalDataDays: 365,
      customRankingsLimit: 10,
      alertsLimit: -1,                   // Elite：无限监控
      emailNotificationsPerMonth: -1,    // 无限邮件
      portfolioSuggestionsLimit: -1,     // 无限组合
    },
    highlights: [
      '无限交易员监控',
      '即时推送通知',
      'AI 智能组合建议',
      '交易员私信功能',
      '跟单者撤离预警',
      '风险分析报告',
      '策略回测功能',
      '365 天历史数据',
      '优先客服支持',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: '企业定制解决方案',
    price: { monthly: -1, yearly: -1, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: -1,
      followLimit: -1,
      comparisonReportsPerMonth: -1,
      exportsPerMonth: -1,
      historicalDataDays: -1,
      customRankingsLimit: -1,
      alertsLimit: -1,
      emailNotificationsPerMonth: -1,
      portfolioSuggestionsLimit: -1,
    },
    highlights: [
      '所有 Elite 功能',
      'API 完整访问',
      '白标定制',
      '专属客户经理',
      '定制化开发',
    ],
  },
]

// ============================================
// 功能列表（按核心价值排序）
// ============================================

export const PREMIUM_FEATURES: PremiumFeature[] = [
  // 核心功能：风险预警系统
  {
    id: 'basic_alerts',
    name: '基础告警',
    description: '监控交易员回撤，应用内提醒',
    icon: '🔔',
    tier: ['free', 'pro', 'elite', 'enterprise'],
    isCore: true,
  },
  {
    id: 'advanced_alerts',
    name: '高级告警',
    description: '回撤急剧加深、胜率下降、跟单者撤离等多维度预警',
    icon: '⚡',
    tier: ['pro', 'elite', 'enterprise'],
    isCore: true,
  },
  {
    id: 'email_notifications',
    name: '邮件通知',
    description: '重要告警通过邮件及时推送',
    icon: '📧',
    tier: ['pro', 'elite', 'enterprise'],
    isCore: true,
  },
  {
    id: 'push_notifications',
    name: '即时推送',
    description: '移动端即时推送，不错过任何预警',
    icon: '📱',
    tier: ['elite', 'enterprise'],
    isCore: true,
  },
  {
    id: 'custom_thresholds',
    name: '自定义阈值',
    description: '根据风险偏好自定义告警触发条件',
    icon: '🎚️',
    tier: ['pro', 'elite', 'enterprise'],
    isCore: true,
  },
  {
    id: 'profit_loss_targets',
    name: '止盈止损提醒',
    description: '设置目标收益和止损线，达标自动提醒',
    icon: '🎯',
    tier: ['pro', 'elite', 'enterprise'],
    isCore: true,
  },
  
  // 组合建议
  {
    id: 'portfolio_suggestions',
    name: '跟单组合建议',
    description: '智能推荐分散风险的交易员组合',
    icon: '📊',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'ai_portfolio',
    name: 'AI 智能组合',
    description: '基于 AI 算法的个性化组合推荐',
    icon: '🤖',
    tier: ['elite', 'enterprise'],
  },
  
  // 数据分析
  {
    id: 'trader_comparison',
    name: '交易员对比',
    description: '多维度对比分析交易员表现',
    icon: '⚖️',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'historical_data',
    name: '历史数据',
    description: '访问更长时间跨度的历史绩效',
    icon: '📅',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'risk_analysis',
    name: '风险分析报告',
    description: '生成详细的风险评估报告',
    icon: '📈',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'strategy_backtest',
    name: '策略回测',
    description: '基于历史数据回测跟单策略',
    icon: '🔬',
    tier: ['elite', 'enterprise'],
  },
  
  // 社交功能
  {
    id: 'trader_messaging',
    name: '交易员私信',
    description: '向已认证交易员发送私信',
    icon: '💬',
    tier: ['elite', 'enterprise'],
  },
  
  // 高级功能
  {
    id: 'portfolio_tracking',
    name: '组合追踪',
    description: '追踪交易员持仓变化',
    icon: '💼',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'custom_rankings',
    name: '自定义排行榜',
    description: '创建专属的筛选排行榜',
    icon: '🏆',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'export_data',
    name: '数据导出',
    description: '导出交易员数据为 CSV/Excel',
    icon: '📥',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'api_access',
    name: 'API 接口',
    description: '通过 API 获取数据',
    icon: '🔌',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'priority_support',
    name: '优先客服',
    description: '专属客服通道，优先响应',
    icon: '🎧',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'white_label',
    name: '白标定制',
    description: '完全定制化品牌',
    icon: '🏷️',
    tier: ['enterprise'],
  },
]

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
 * 检查用户是否可以添加更多告警配置
 */
export function canAddMoreAlerts(tier: SubscriptionTier, currentCount: number): boolean {
  const limits = getFeatureLimits(tier)
  if (limits.alertsLimit === -1) return true  // 无限
  return currentCount < limits.alertsLimit
}

/**
 * 获取告警限制数量
 */
export function getAlertsLimit(tier: SubscriptionTier): number | 'unlimited' {
  const limits = getFeatureLimits(tier)
  return limits.alertsLimit === -1 ? 'unlimited' : limits.alertsLimit
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
  const tierOrder: SubscriptionTier[] = ['free', 'pro', 'elite', 'enterprise']
  const currentIndex = tierOrder.indexOf(tier)
  
  if (currentIndex <= 0) {
    return PREMIUM_FEATURES.filter(f => f.tier.includes(tier))
  }
  
  const previousTier = tierOrder[currentIndex - 1]
  return PREMIUM_FEATURES.filter(
    f => f.tier.includes(tier) && !f.tier.includes(previousTier)
  )
}
