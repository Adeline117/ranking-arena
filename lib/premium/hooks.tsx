'use client'

/**
 * 会员系统 React Hooks
 */

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react'
import {
  premiumService,
  type UserSubscription,
  type FeatureCheckResult,
  type SubscriptionTier,
  type PremiumFeatureId,
} from './index'

// ============================================
// Context
// ============================================

interface PremiumContextValue {
  /** 当前订阅 */
  subscription: UserSubscription | null
  /** 是否加载中 */
  isLoading: boolean
  /** 是否为付费用户 */
  isPremium: boolean
  /** 当前等级 */
  tier: SubscriptionTier
  /** 检查功能访问 */
  checkFeature: (featureId: PremiumFeatureId) => FeatureCheckResult
  /** 刷新订阅状态 */
  refresh: () => Promise<void>
}

const PremiumContext = createContext<PremiumContextValue | null>(null)

// ============================================
// Provider
// ============================================

interface PremiumProviderProps {
  children: ReactNode
  /** 初始订阅数据（用于 SSR） */
  initialSubscription?: UserSubscription
}

export function PremiumProvider({ children, initialSubscription }: PremiumProviderProps) {
  const [subscription, setSubscription] = useState<UserSubscription | null>(initialSubscription || null)
  const [isLoading, setIsLoading] = useState(!initialSubscription)

  // 加载订阅状态
  const loadSubscription = useCallback(async () => {
    try {
      setIsLoading(true)
      
      // 动态导入 supabase 避免服务端问题
      const { supabase } = await import('@/lib/supabase/client')
      const { data: { session } } = await supabase.auth.getSession()
      
      if (!session?.access_token) {
        // 未登录，使用默认免费订阅
        const defaultSub = premiumService.getSubscription()
        setSubscription(defaultSub)
        return
      }
      
      // 尝试从 API 获取订阅状态（携带认证信息）
      const response = await fetch('/api/subscription', {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      }).catch(() => null)
      
      if (response?.ok) {
        const data = await response.json()
        if (data.subscription) {
          setSubscription(data.subscription)
          premiumService.setSubscription(data.subscription)
          return
        }
      }
      
      // API 未实现或失败时使用默认值
      const defaultSub = premiumService.getSubscription()
      setSubscription(defaultSub)
    } catch (error) {
      // 静默处理错误，使用默认订阅
      const defaultSub = premiumService.getSubscription()
      setSubscription(defaultSub)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!initialSubscription) {
      loadSubscription()
    }
  }, [initialSubscription, loadSubscription])

  const checkFeature = useCallback((featureId: PremiumFeatureId): FeatureCheckResult => {
    return premiumService.checkFeatureAccess(featureId)
  }, [])

  const refresh = useCallback(async () => {
    await loadSubscription()
  }, [loadSubscription])

  const value: PremiumContextValue = {
    subscription,
    isLoading,
    isPremium: subscription ? premiumService.isPremiumUser() : false,
    tier: subscription?.tier || 'free',
    checkFeature,
    refresh,
  }

  return (
    <PremiumContext.Provider value={value}>
      {children}
    </PremiumContext.Provider>
  )
}

// ============================================
// Hooks
// ============================================

/**
 * 获取会员上下文
 */
export function usePremium(): PremiumContextValue {
  const context = useContext(PremiumContext)
  if (!context) {
    throw new Error('usePremium must be used within a PremiumProvider')
  }
  return context
}

/**
 * 检查功能访问权限
 */
export function useFeatureAccess(featureId: PremiumFeatureId): FeatureCheckResult & { isLoading: boolean } {
  const { checkFeature, isLoading } = usePremium()
  const result = checkFeature(featureId)
  return { ...result, isLoading }
}

/**
 * 检查是否为付费用户
 */
export function useIsPremium(): { isPremium: boolean; isLoading: boolean; tier: SubscriptionTier } {
  const { isPremium, isLoading, tier } = usePremium()
  return { isPremium, isLoading, tier }
}

/**
 * 关注限额检查
 */
export function useFollowLimit(): FeatureCheckResult & { isLoading: boolean } {
  const { isLoading } = usePremium()
  const result = premiumService.checkFollowLimit()
  return { ...result, isLoading }
}

/**
 * 历史数据访问检查
 */
export function useHistoricalDataAccess(requestedDays: number): FeatureCheckResult & { isLoading: boolean } {
  const { isLoading } = usePremium()
  const result = premiumService.checkHistoricalDataAccess(requestedDays)
  return { ...result, isLoading }
}

/**
 * 升级建议
 */
export function useUpgradeSuggestion(): {
  suggestion: { targetTier: SubscriptionTier; message: string } | null
  isLoading: boolean
} {
  const { isLoading } = usePremium()
  const suggestion = premiumService.getUpgradeSuggestion()
  return { suggestion, isLoading }
}

/**
 * 功能配额状态
 */
export function useFeatureQuota(featureId: PremiumFeatureId): {
  used: number
  limit: number
  remaining: number
  percentage: number
  isLoading: boolean
} {
  const { subscription, isLoading } = usePremium()
  
  if (!subscription) {
    return { used: 0, limit: 0, remaining: 0, percentage: 0, isLoading }
  }

  const usage = subscription.usage
  const limits = premiumService.getSubscription().usage

  // 根据功能 ID 获取对应的使用量和限制
  let used = 0
  let limit = 0

  switch (featureId) {
    case 'api_access':
      used = usage.apiCallsToday
      limit = premiumService.checkFeatureAccess('api_access').remaining + used
      break
    case 'trader_comparison':
      used = usage.comparisonReportsThisMonth
      limit = premiumService.checkFeatureAccess('trader_comparison').remaining + used
      break
    case 'export_data':
      used = usage.exportsThisMonth
      limit = premiumService.checkFeatureAccess('export_data').remaining + used
      break
    case 'custom_rankings':
      used = usage.currentCustomRankings
      limit = premiumService.checkFeatureAccess('custom_rankings').remaining + used
      break
  }

  const remaining = Math.max(0, limit - used)
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0

  return { used, limit, remaining, percentage, isLoading }
}

// ============================================
// 条件渲染组件
// ============================================

interface PremiumGateProps {
  /** 需要的功能 ID */
  feature?: PremiumFeatureId
  /** 需要的最低等级 */
  tier?: SubscriptionTier
  /** 有权限时渲染的内容 */
  children: ReactNode
  /** 无权限时渲染的内容 */
  fallback?: ReactNode
}

/**
 * 付费功能门控组件
 */
export function PremiumGate({ feature, tier, children, fallback = null }: PremiumGateProps) {
  const { tier: currentTier, checkFeature, isLoading } = usePremium()

  if (isLoading) {
    return null
  }

  // 检查等级
  if (tier) {
    const tierOrder: SubscriptionTier[] = ['free', 'pro']
    const currentIndex = tierOrder.indexOf(currentTier)
    const requiredIndex = tierOrder.indexOf(tier)
    
    if (currentIndex < requiredIndex) {
      return <>{fallback}</>
    }
  }

  // 检查功能
  if (feature) {
    const { hasAccess } = checkFeature(feature)
    if (!hasAccess) {
      return <>{fallback}</>
    }
  }

  return <>{children}</>
}

/**
 * 仅付费用户可见
 */
export function PremiumOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { isPremium, isLoading } = usePremium()

  if (isLoading) return null
  if (!isPremium) return <>{fallback}</>

  return <>{children}</>
}

/**
 * 仅免费用户可见
 */
export function FreeOnly({ children }: { children: ReactNode }) {
  const { isPremium, isLoading } = usePremium()

  if (isLoading) return null
  if (isPremium) return null

  return <>{children}</>
}
