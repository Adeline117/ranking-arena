/**
 * 付费增值功能类型定义
 * 包含订阅计划、功能权限和 API 配额
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
}

// ============================================
// 功能定义
// ============================================

export type PremiumFeatureId = 
  | 'advanced_analytics'      // 高级数据分析
  | 'trader_comparison'       // 交易员对比报告
  | 'api_access'             // API 接口访问
  | 'realtime_alerts'        // 实时通知推送
  | 'portfolio_tracking'     // 投资组合追踪
  | 'custom_rankings'        // 自定义排行榜
  | 'export_data'            // 数据导出
  | 'historical_data'        // 历史数据访问
  | 'risk_analysis'          // 风险分析报告
  | 'strategy_backtest'      // 策略回测
  | 'priority_support'       // 优先客服支持
  | 'white_label'            // 白标定制

export interface PremiumFeature {
  id: PremiumFeatureId
  name: string
  description: string
  icon: string
  tier: SubscriptionTier[]  // 哪些订阅等级包含此功能
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
  /** 实时告警数量 */
  alertsLimit: number
}

// ============================================
// 预定义计划
// ============================================

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'free',
    name: '免费版',
    description: '基础功能，适合个人用户入门',
    price: { monthly: 0, yearly: 0, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 0,
      followLimit: 10,
      comparisonReportsPerMonth: 0,
      exportsPerMonth: 0,
      historicalDataDays: 7,
      customRankingsLimit: 0,
      alertsLimit: 3,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    description: '进阶功能，适合活跃交易者',
    price: { monthly: 9.9, yearly: 99, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 1000,
      followLimit: 50,
      comparisonReportsPerMonth: 10,
      exportsPerMonth: 10,
      historicalDataDays: 90,
      customRankingsLimit: 3,
      alertsLimit: 20,
    },
    badge: '最受欢迎',
    recommended: true,
  },
  {
    id: 'elite',
    name: 'Elite',
    description: '专业功能，适合机构和专业投资者',
    price: { monthly: 29.9, yearly: 299, currency: 'USD' },
    features: [],
    limits: {
      apiCallsPerDay: 10000,
      followLimit: 200,
      comparisonReportsPerMonth: 50,
      exportsPerMonth: 50,
      historicalDataDays: 365,
      customRankingsLimit: 10,
      alertsLimit: 100,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: '企业定制，无限功能',
    price: { monthly: -1, yearly: -1, currency: 'USD' }, // 联系销售
    features: [],
    limits: {
      apiCallsPerDay: -1, // 无限
      followLimit: -1,
      comparisonReportsPerMonth: -1,
      exportsPerMonth: -1,
      historicalDataDays: -1,
      customRankingsLimit: -1,
      alertsLimit: -1,
    },
  },
]

export const PREMIUM_FEATURES: PremiumFeature[] = [
  {
    id: 'advanced_analytics',
    name: '高级数据分析',
    description: '深度分析交易员绩效，包含夏普率、波动率等专业指标',
    icon: '📊',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'trader_comparison',
    name: '交易员对比报告',
    description: '生成多维度交易员对比报告，支持导出 PDF',
    icon: '⚖️',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'api_access',
    name: 'API 接口',
    description: '通过 RESTful API 获取排行榜数据，集成到您的系统',
    icon: '🔌',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'realtime_alerts',
    name: '实时告警',
    description: '关注的交易员有重大变动时，实时推送通知',
    icon: '🔔',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'portfolio_tracking',
    name: '投资组合追踪',
    description: '追踪交易员持仓变化，分析投资组合表现',
    icon: '💼',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'custom_rankings',
    name: '自定义排行榜',
    description: '自定义筛选条件，创建专属排行榜',
    icon: '🏆',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'export_data',
    name: '数据导出',
    description: '导出交易员数据为 CSV/Excel 格式',
    icon: '📥',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'historical_data',
    name: '历史数据',
    description: '访问更长时间跨度的历史绩效数据',
    icon: '📅',
    tier: ['pro', 'elite', 'enterprise'],
  },
  {
    id: 'risk_analysis',
    name: '风险分析报告',
    description: '生成详细的风险评估报告，包含压力测试',
    icon: '⚠️',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'strategy_backtest',
    name: '策略回测',
    description: '基于历史数据回测跟单策略效果',
    icon: '🔬',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'priority_support',
    name: '优先客服',
    description: '专属客服通道，优先响应您的问题',
    icon: '💎',
    tier: ['elite', 'enterprise'],
  },
  {
    id: 'white_label',
    name: '白标定制',
    description: '完全定制化品牌，嵌入您的产品',
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
