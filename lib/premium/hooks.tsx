'use client'

/**
 * 会员系统 React Hooks
 */

import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, ReactNode } from 'react'
import {
  premiumService,
  type UserSubscription,
  type FeatureCheckResult,
  type SubscriptionTier,
  type PremiumFeatureId,
  SUBSCRIPTION_PLANS,
} from './index'
import { logger } from '@/lib/logger'

// ============================================
// Feature Limits Export (for UI display)
// ============================================

const freePlan = SUBSCRIPTION_PLANS.find(p => p.id === 'free')!
const proPlan = SUBSCRIPTION_PLANS.find(p => p.id === 'pro')!

export const FEATURE_LIMITS = {
  free: {
    maxFollows: freePlan.limits.followLimit,
    historicalDays: freePlan.limits.historicalDataDays,
    apiCallsPerDay: freePlan.limits.apiCallsPerDay,
  },
  pro: {
    maxFollows: proPlan.limits.followLimit,
    historicalDays: proPlan.limits.historicalDataDays,
    apiCallsPerDay: proPlan.limits.apiCallsPerDay,
  },
} as const

// ============================================
// Context
// ============================================

/**
 * Beta mode: unlock all Pro features for everyone during early launch.
 * Set to false when paywalls should be enforced.
 *
 * ⚠️ SECURITY: This flag MUST be false in production.
 * Setting to true bypasses ALL paywalls — revenue impact.
 * Changed to false on 2026-03-28 to enforce the paywall.
 */
export const BETA_PRO_FEATURES_FREE = false

// Runtime safeguard: prevent accidental enabling via env var in production
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_BETA_PRO_FREE === 'true') {
  console.error('CRITICAL: NEXT_PUBLIC_BETA_PRO_FREE=true is not allowed in production. Ignoring.')
}

interface PremiumContextValue {
  /** 当前订阅 */
  subscription: UserSubscription | null
  /** 是否加载中 */
  isLoading: boolean
  /** 是否为付费用户（有实际订阅） */
  isPremium: boolean
  /**
   * 当前是否可以访问所有 Pro 功能。
   * Beta 期间等于 true（全员解锁），正式收费后等于 isPremium。
   */
  isFeaturesUnlocked: boolean
  /** 当前等级 */
  tier: SubscriptionTier
  /** 订阅来源 */
  source: 'stripe' | 'nft' | 'admin' | 'free'
  /** 是否持有 NFT 会员 */
  hasNFT: boolean
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
  const [hasNFT, setHasNFT] = useState(false)
  const [_source, setSource] = useState<'stripe' | 'nft' | 'admin' | 'free'>('free')
  // Track subscription in a ref so checkNFTMembership can read it without being
  // recreated on every subscription state change (which was causing useEffect churn)
  const subscriptionRef = useRef(subscription)
  useEffect(() => { subscriptionRef.current = subscription }, [subscription])

  // 加载订阅状态
  const loadSubscription = useCallback(async () => {
    try {
      setIsLoading(true)

      // 动态导入 supabase 避免服务端问题
      const { supabase } = await import('@/lib/supabase/client')
      let { data: { session } } = await supabase.auth.getSession()

      // 检查 token 是否过期或即将过期，尝试刷新
      if (session?.expires_at) {
        const now = Math.floor(Date.now() / 1000)
        if (session.expires_at - now < 60) {
          const { data: refreshed } = await supabase.auth.refreshSession()
          session = refreshed.session
        }
      } else if (!session?.access_token) {
        // 尝试刷新获取新 session
        const { data: refreshed } = await supabase.auth.refreshSession()
        session = refreshed.session
      }

      if (!session?.access_token) {
        // 未登录，使用默认免费订阅
        const defaultSub = premiumService.getSubscription()
        setSubscription(defaultSub)
        return
      }
      
      // 尝试从 API 获取订阅状态（携带认证信息）
      try {
        const response = await fetch('/api/subscription', {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        })

        if (response.ok) {
          const data = await response.json()
          if (data.subscription) {
            setSubscription(data.subscription)
            premiumService.setSubscription(data.subscription)
            return
          }
        } else {
          logger.warn('[PremiumProvider] Subscription API returned error:', response.status)
        }
      } catch (fetchError) {
        logger.error('[PremiumProvider] Failed to fetch subscription:', fetchError)
      }
      
      // API 未实现或失败时，尝试直接从数据库查询（降级方案）
      try {
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', session.user.id)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (subscription && subscription.tier === 'pro') {
          const fallbackSub: UserSubscription = {
            userId: session.user.id,
            tier: 'pro',
            status: subscription.status as UserSubscription['status'],
            startDate: new Date().toISOString(),
            endDate: null,
            trialEndDate: null,
            autoRenew: subscription.status === 'active',
            usage: {
              apiCallsToday: 0,
              comparisonReportsThisMonth: 0,
              exportsThisMonth: 0,
              currentFollows: 0,
              currentCustomRankings: 0,
            },
          }
          setSubscription(fallbackSub)
          premiumService.setSubscription(fallbackSub)
          return
        }

        // 最后检查 user_profiles
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('subscription_tier')
          .eq('id', session.user.id)
          .maybeSingle()

        if (profile?.subscription_tier === 'pro') {
          const fallbackSub: UserSubscription = {
            userId: session.user.id,
            tier: 'pro',
            status: 'active',
            startDate: new Date().toISOString(),
            endDate: null,
            trialEndDate: null,
            autoRenew: true,
            usage: {
              apiCallsToday: 0,
              comparisonReportsThisMonth: 0,
              exportsThisMonth: 0,
              currentFollows: 0,
              currentCustomRankings: 0,
            },
          }
          setSubscription(fallbackSub)
          premiumService.setSubscription(fallbackSub)
          return
        }
      } catch (dbError) {
        logger.error('[PremiumProvider] Failed to query database:', dbError)
      }
      
      // 所有方法都失败时使用默认值
      const defaultSub = premiumService.getSubscription()
      setSubscription(defaultSub)
    } catch (_error) {
      // 静默处理错误，使用默认订阅
      const defaultSub = premiumService.getSubscription()
      setSubscription(defaultSub)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Check NFT membership in parallel (non-blocking enhancement)
  // Uses subscriptionRef (not subscription state) so this callback is stable and
  // is not recreated on every subscription change, preventing useEffect re-trigger churn.
  const checkNFTMembership = useCallback(async () => {
    try {
      const { supabase } = await import('@/lib/supabase/client')
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch('/api/membership/nft', {
        headers: { 'Authorization': `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const { hasNFT: nft } = await res.json()
        setHasNFT(nft)
        if (nft) {
          setSource('nft')
          // If NFT holder but no Stripe sub, treat as pro — read from ref to avoid dep
          if (!subscriptionRef.current || subscriptionRef.current.tier === 'free') {
            const nftSub: UserSubscription = {
              userId: session.user.id,
              tier: 'pro',
              status: 'active',
              startDate: new Date().toISOString(),
              endDate: null,
              trialEndDate: null,
              autoRenew: false,
              paymentMethod: undefined,
              usage: {
                apiCallsToday: 0,
                comparisonReportsThisMonth: 0,
                exportsThisMonth: 0,
                currentFollows: 0,
                currentCustomRankings: 0,
              },
            }
            setSubscription(nftSub)
            premiumService.setSubscription(nftSub)
          }
        }
      }
    } catch (_err) {
      // Intentionally swallowed: NFT-based premium check is optional, Stripe subscription is primary
    }
  }, []) // stable — subscription read via subscriptionRef to avoid recreation on sub change

  // Defer subscription load until browser is idle — this makes network requests
  // to /api/subscription and Supabase auth, which block the main thread during
  // initial hydration. Since BETA_PRO_FEATURES_FREE=true, all features are
  // unlocked by default, so there's no urgency.
  useEffect(() => {
    if (!initialSubscription) {
      if ('requestIdleCallback' in window) {
        const id = requestIdleCallback(() => loadSubscription(), { timeout: 4000 })
        return () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(() => loadSubscription(), 2000)
        return () => clearTimeout(id)
      }
    }
  }, [initialSubscription, loadSubscription])

  // Run NFT check after subscription loads
  useEffect(() => {
    if (!isLoading) {
      checkNFTMembership()
    }
  }, [isLoading, checkNFTMembership])

  const checkFeature = useCallback((featureId: PremiumFeatureId): FeatureCheckResult => {
    return premiumService.checkFeatureAccess(featureId)
  }, [])

  const refresh = useCallback(async () => {
    await loadSubscription()
  }, [loadSubscription])

  const value = useMemo<PremiumContextValue>(() => {
    const actualIsPremium = (subscription ? premiumService.isPremiumUser() : false) || hasNFT
    // During open beta, all users get premium features unlocked
    const effectiveIsPremium = BETA_PRO_FEATURES_FREE || actualIsPremium
    return {
      subscription,
      isLoading,
      isPremium: effectiveIsPremium,
      isFeaturesUnlocked: effectiveIsPremium,
      tier: (subscription?.tier || 'free') === 'free' && hasNFT ? 'pro' : (subscription?.tier || 'free'),
      source: hasNFT ? 'nft' : (subscription?.paymentMethod === 'stripe' ? 'stripe' : 'free'),
      hasNFT,
      checkFeature,
      refresh,
    }
  }, [subscription, isLoading, hasNFT, checkFeature, refresh])

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
  const _limits = premiumService.getSubscription().usage

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
