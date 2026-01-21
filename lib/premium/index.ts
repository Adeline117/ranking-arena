/**
 * 会员系统核心模块
 * 管理订阅状态、权益和访问控制
 */

import {
  type SubscriptionTier,
  type PremiumFeatureId,
  type FeatureLimits,
  SUBSCRIPTION_PLANS,
  PREMIUM_FEATURES,
  hasFeatureAccess,
  getFeatureLimits,
  normalizeSubscriptionTier,
} from '@/lib/types/premium'

// ============================================
// 类型定义
// ============================================

export interface UserSubscription {
  /** 用户 ID */
  userId: string
  /** 订阅等级 */
  tier: SubscriptionTier
  /** 订阅状态 */
  status: 'active' | 'cancelled' | 'past_due' | 'trialing' | 'expired'
  /** 开始时间 */
  startDate: string
  /** 到期时间 */
  endDate: string | null
  /** 试用结束时间 */
  trialEndDate: string | null
  /** 是否自动续费 */
  autoRenew: boolean
  /** 支付方式 */
  paymentMethod?: 'stripe' | 'paypal' | 'crypto'
  /** 已使用配额 */
  usage: FeatureUsage
}

export interface FeatureUsage {
  /** 今日 API 调用次数 */
  apiCallsToday: number
  /** 本月对比报告数 */
  comparisonReportsThisMonth: number
  /** 本月导出次数 */
  exportsThisMonth: number
  /** 当前关注数 */
  currentFollows: number
  /** 当前自定义排行榜数 */
  currentCustomRankings: number
}

export interface FeatureCheckResult {
  /** 是否有权限 */
  hasAccess: boolean
  /** 是否达到限额 */
  isLimitReached: boolean
  /** 剩余配额 */
  remaining: number
  /** 限制说明 */
  message?: string
  /** 升级提示 */
  upgradeMessage?: string
}

// ============================================
// 默认值
// ============================================

const DEFAULT_SUBSCRIPTION: UserSubscription = {
  userId: '',
  tier: 'free',
  status: 'active',
  startDate: new Date().toISOString(),
  endDate: null,
  trialEndDate: null,
  autoRenew: false,
  usage: {
    apiCallsToday: 0,
    comparisonReportsThisMonth: 0,
    exportsThisMonth: 0,
    currentFollows: 0,
    currentCustomRankings: 0,
  },
}

// ============================================
// 会员服务类
// ============================================

class PremiumService {
  private subscription: UserSubscription = DEFAULT_SUBSCRIPTION

  /**
   * 设置当前用户订阅
   */
  setSubscription(subscription: UserSubscription): void {
    this.subscription = subscription
  }

  /**
   * 获取当前订阅
   */
  getSubscription(): UserSubscription {
    return this.subscription
  }

  /**
   * 获取当前等级
   */
  getTier(): SubscriptionTier {
    return this.subscription.tier
  }

  /**
   * 检查订阅是否有效
   */
  isSubscriptionActive(): boolean {
    return this.subscription.status === 'active' || this.subscription.status === 'trialing'
  }

  /**
   * 检查是否为付费用户
   */
  isPremiumUser(): boolean {
    return this.subscription.tier !== 'free' && this.isSubscriptionActive()
  }

  /**
   * 检查功能访问权限
   */
  checkFeatureAccess(featureId: PremiumFeatureId): FeatureCheckResult {
    const hasAccess = hasFeatureAccess(this.subscription.tier, featureId)
    const limits = getFeatureLimits(this.subscription.tier)
    const usage = this.subscription.usage

    // 根据功能类型检查配额
    let isLimitReached = false
    let remaining = -1
    let message: string | undefined
    let upgradeMessage: string | undefined

    if (!hasAccess) {
      upgradeMessage = '升级到 Pro 解锁此功能'
      message = '此功能需要升级订阅'
    } else {
      // 检查具体功能的配额
      switch (featureId) {
        case 'api_access':
          if (limits.apiCallsPerDay > 0) {
            remaining = limits.apiCallsPerDay - usage.apiCallsToday
            isLimitReached = remaining <= 0
            if (isLimitReached) {
              message = `今日 API 调用已达上限 (${limits.apiCallsPerDay})`
            }
          }
          break
        case 'trader_comparison':
          if (limits.comparisonReportsPerMonth > 0) {
            remaining = limits.comparisonReportsPerMonth - usage.comparisonReportsThisMonth
            isLimitReached = remaining <= 0
            if (isLimitReached) {
              message = `本月对比报告已达上限 (${limits.comparisonReportsPerMonth})`
            }
          }
          break
        case 'export_data':
          if (limits.exportsPerMonth > 0) {
            remaining = limits.exportsPerMonth - usage.exportsThisMonth
            isLimitReached = remaining <= 0
            if (isLimitReached) {
              message = `本月导出次数已达上限 (${limits.exportsPerMonth})`
            }
          }
          break
        case 'custom_rankings':
          if (limits.customRankingsLimit > 0) {
            remaining = limits.customRankingsLimit - usage.currentCustomRankings
            isLimitReached = remaining <= 0
            if (isLimitReached) {
              message = `自定义排行榜已达上限 (${limits.customRankingsLimit})`
            }
          }
          break
      }

      if (isLimitReached) {
        upgradeMessage = '升级套餐获取更多配额'
      }
    }

    return {
      hasAccess,
      isLimitReached,
      remaining,
      message,
      upgradeMessage,
    }
  }

  /**
   * 检查关注限额
   */
  checkFollowLimit(): FeatureCheckResult {
    const limits = getFeatureLimits(this.subscription.tier)
    const remaining = limits.followLimit > 0 
      ? limits.followLimit - this.subscription.usage.currentFollows 
      : -1
    const isLimitReached = limits.followLimit > 0 && remaining <= 0

    return {
      hasAccess: true,
      isLimitReached,
      remaining,
      message: isLimitReached ? `关注数量已达上限 (${limits.followLimit})` : undefined,
      upgradeMessage: isLimitReached ? '升级套餐关注更多交易员' : undefined,
    }
  }

  /**
   * 检查历史数据访问
   */
  checkHistoricalDataAccess(requestedDays: number): FeatureCheckResult {
    const limits = getFeatureLimits(this.subscription.tier)
    const hasAccess = limits.historicalDataDays === -1 || requestedDays <= limits.historicalDataDays

    return {
      hasAccess,
      isLimitReached: !hasAccess,
      remaining: limits.historicalDataDays === -1 ? -1 : limits.historicalDataDays,
      message: !hasAccess ? `历史数据仅支持 ${limits.historicalDataDays} 天` : undefined,
      upgradeMessage: !hasAccess ? '升级套餐访问更长历史数据' : undefined,
    }
  }

  /**
   * 获取可用功能列表
   */
  getAvailableFeatures(): PremiumFeatureId[] {
    const normalizedTier = normalizeSubscriptionTier(this.subscription.tier)
    return PREMIUM_FEATURES
      .filter(f => f.tier.includes(normalizedTier))
      .map(f => f.id)
  }

  /**
   * 获取升级建议
   */
  getUpgradeSuggestion(): { targetTier: SubscriptionTier; message: string } | null {
    const normalizedTier = normalizeSubscriptionTier(this.subscription.tier)
    const currentIndex = SUBSCRIPTION_PLANS.findIndex(p => p.id === normalizedTier)
    if (currentIndex === -1 || currentIndex >= SUBSCRIPTION_PLANS.length - 1) {
      return null
    }

    const nextPlan = SUBSCRIPTION_PLANS[currentIndex + 1]
    return {
      targetTier: nextPlan.id,
      message: `升级到 ${nextPlan.name}，解锁更多功能`,
    }
  }

  /**
   * 更新使用量
   */
  updateUsage(updates: Partial<FeatureUsage>): void {
    this.subscription.usage = {
      ...this.subscription.usage,
      ...updates,
    }
  }

  /**
   * 重置每日使用量
   */
  resetDailyUsage(): void {
    this.subscription.usage.apiCallsToday = 0
  }

  /**
   * 重置每月使用量
   */
  resetMonthlyUsage(): void {
    this.subscription.usage.comparisonReportsThisMonth = 0
    this.subscription.usage.exportsThisMonth = 0
  }
}

// ============================================
// 全局实例
// ============================================

export const premiumService = new PremiumService()

// ============================================
// 便捷函数
// ============================================

/**
 * 检查用户是否为 Pro 会员
 */
export function isProOrAbove(tier: SubscriptionTier): boolean {
  return tier === 'pro'
}

/**
 * 检查用户是否为 Pro 会员（别名，保持向后兼容）
 */
export function isPro(tier: SubscriptionTier): boolean {
  return tier === 'pro'
}

/**
 * 获取订阅计划详情
 */
export function getPlan(tier: SubscriptionTier) {
  return SUBSCRIPTION_PLANS.find(p => p.id === tier)
}

/**
 * 获取功能详情
 */
export function getFeature(featureId: PremiumFeatureId) {
  return PREMIUM_FEATURES.find(f => f.id === featureId)
}

// ============================================
// 重新导出
// ============================================

export {
  type SubscriptionTier,
  type PremiumFeatureId,
  type FeatureLimits,
  SUBSCRIPTION_PLANS,
  PREMIUM_FEATURES,
  hasFeatureAccess,
  getFeatureLimits,
} from '@/lib/types/premium'

// Types are re-exported from @/lib/types/premium
export { PremiumService }
