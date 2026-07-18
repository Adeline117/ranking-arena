'use client'

/**
 * 会员系统 React Hooks
 */

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
  ReactNode,
} from 'react'
import {
  PremiumService,
  type UserSubscription,
  type FeatureCheckResult,
  type SubscriptionTier,
  type PremiumFeatureId,
  SUBSCRIPTION_PLANS,
} from './index'
import { logger } from '@/lib/logger'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getAuthSession } from '@/lib/auth'

// ============================================
// Feature Limits Export (for UI display)
// ============================================

const freePlan = SUBSCRIPTION_PLANS.find((p) => p.id === 'free')!
const proPlan = SUBSCRIPTION_PLANS.find((p) => p.id === 'pro')!

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
 * Client-side unlock flag — bound to the single source of truth `PRO_FREE_PROMO`
 * in `lib/types/premium.ts` so client + server share ONE flag.
 *
 * During the "Pro features free for a limited time" promo this is `true`, so
 * `useSubscription()` / `effectiveIsPremium` treat everyone as Pro and ProGate
 * renders children ungated (no lock UI).
 *
 * ⚠️ ONE-LINE REVERT: set `NEXT_PUBLIC_PRO_FREE_PROMO=false` at build time.
 * That one environment change restores the full paywall on BOTH client (this const) and
 * server (`hasFeatureAccess`/`getFeatureLimits`) and hides the promo banner.
 * Do NOT hardcode this back to `false` — keep it bound to PRO_FREE_PROMO.
 */
export const BETA_PRO_FEATURES_FREE = PRO_FREE_PROMO

// Runtime safeguard: prevent accidental enabling via env var in production
if (
  typeof process !== 'undefined' &&
  process.env.NODE_ENV === 'production' &&
  process.env.NEXT_PUBLIC_BETA_PRO_FREE === 'true'
) {
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
  source: 'stripe' | 'admin' | 'free'
  /** 是否持有可展示的链上 NFT 徽章（不代表 Pro 权限） */
  hasNFT: boolean
  /** 检查功能访问 */
  checkFeature: (featureId: PremiumFeatureId) => FeatureCheckResult
  /** 刷新订阅状态 */
  refresh: () => Promise<void>
}

const PremiumContext = createContext<PremiumContextValue | null>(null)

function createFreeSubscription(userId = ''): UserSubscription {
  const base = new PremiumService().getSubscription()
  return {
    ...base,
    userId,
    startDate: new Date().toISOString(),
    usage: { ...base.usage },
  }
}

function serviceForSubscription(subscription: UserSubscription | null): PremiumService {
  const service = new PremiumService()
  if (subscription) service.setSubscription(subscription)
  return service
}

// ============================================
// Provider
// ============================================

interface PremiumProviderProps {
  children: ReactNode
  /** 初始订阅数据（用于 SSR） */
  initialSubscription?: UserSubscription
}

export function PremiumProvider({ children, initialSubscription }: PremiumProviderProps) {
  const auth = useAuthSession()
  const scopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const activeScopeRef = useRef({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  })
  activeScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  }
  const stateOwnerScopeKeyRef = useRef(scopeKey)
  const [subscriptionState, setSubscription] = useState<UserSubscription | null>(
    initialSubscription || null
  )
  const [isLoadingState, setIsLoading] = useState(!initialSubscription)
  const [hasNFTState, setHasNFT] = useState(false)
  const stateScopeOwned = stateOwnerScopeKeyRef.current === scopeKey
  const subscription = stateScopeOwned ? subscriptionState : null
  const isLoading = stateScopeOwned ? isLoadingState : true
  const hasNFT = stateScopeOwned ? hasNFTState : false
  const scopeIsCurrent = useCallback(
    (scope: { viewerKey: string; sessionGeneration: number; userId: string | null }) => {
      const current = activeScopeRef.current
      return (
        current.viewerKey === scope.viewerKey &&
        current.sessionGeneration === scope.sessionGeneration &&
        current.userId === scope.userId
      )
    },
    []
  )
  const claimScope = useCallback(
    (scope: { viewerKey: string; sessionGeneration: number; userId: string | null }) => {
      if (!scopeIsCurrent(scope)) return false
      const ownerScopeKey = `${scope.viewerKey}\u0000${scope.sessionGeneration}`
      if (stateOwnerScopeKeyRef.current !== ownerScopeKey) {
        stateOwnerScopeKeyRef.current = ownerScopeKey
        setSubscription(null)
        setIsLoading(true)
        setHasNFT(false)
      }
      return true
    },
    [scopeIsCurrent]
  )
  // 加载订阅状态
  const loadSubscription = useCallback(async () => {
    const capturedScope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    if (!auth.authChecked || !claimScope(capturedScope)) return
    try {
      setIsLoading(true)

      // 动态导入 supabase 避免服务端问题
      const { supabase } = await import('@/lib/supabase/client')
      const session = await getAuthSession()
      if (!scopeIsCurrent(capturedScope)) return

      if (!session) {
        // 未登录，使用默认免费订阅
        const defaultSub = createFreeSubscription()
        setSubscription(defaultSub)
        return
      }

      // 尝试从 API 获取订阅状态（携带认证信息）
      try {
        const response = await fetch('/api/subscription', {
          method: 'GET',
          credentials: 'include',
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
          },
        })

        if (!scopeIsCurrent(capturedScope)) return
        if (response.ok) {
          const data = await response.json()
          if (data.subscription && scopeIsCurrent(capturedScope)) {
            setSubscription(data.subscription)
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
        if (!scopeIsCurrent(capturedScope)) return
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', session.userId)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (subscription && subscription.tier === 'pro' && scopeIsCurrent(capturedScope)) {
          const fallbackSub: UserSubscription = {
            userId: session.userId,
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
          return
        }

        // 最后检查 user_profiles
        if (!scopeIsCurrent(capturedScope)) return
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('subscription_tier')
          .eq('id', session.userId)
          .maybeSingle()

        if (profile?.subscription_tier === 'pro' && scopeIsCurrent(capturedScope)) {
          const fallbackSub: UserSubscription = {
            userId: session.userId,
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
          return
        }
      } catch (dbError) {
        logger.error('[PremiumProvider] Failed to query database:', dbError)
      }

      // 所有方法都失败时使用默认值
      if (scopeIsCurrent(capturedScope)) {
        setSubscription(createFreeSubscription(session.userId))
      }
    } catch (err) {
      // Log so silent downgrade-to-free is visible in DevTools / server logs
      console.error('[premium] subscription load failed:', err)
      if (scopeIsCurrent(capturedScope)) {
        setSubscription(createFreeSubscription(capturedScope.userId || ''))
      }
    } finally {
      if (scopeIsCurrent(capturedScope)) setIsLoading(false)
    }
  }, [
    auth.authChecked,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    claimScope,
    scopeIsCurrent,
  ])

  // Check the on-chain badge in parallel. Badge ownership is display-only and
  // must not create or replace a paid Pro subscription.
  const checkNFTMembership = useCallback(async () => {
    const capturedScope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    if (!auth.authChecked || !claimScope(capturedScope)) return
    try {
      const session = await getAuthSession()
      if (!session || !scopeIsCurrent(capturedScope)) return

      const res = await fetch('/api/membership/nft', {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      })
      if (res.ok && scopeIsCurrent(capturedScope)) {
        const { hasNft } = await res.json()
        if (!scopeIsCurrent(capturedScope)) return
        setHasNFT(hasNft === true)
      }
    } catch (_err) {
      // Intentionally swallowed: NFT-based premium check is optional, Stripe subscription is primary
    }
  }, [
    auth.authChecked,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
    claimScope,
    scopeIsCurrent,
  ])

  // Load subscription immediately on mount. Previously deferred via
  // requestIdleCallback (up to 4s), which caused Pro users to see locked
  // content for 2-4 seconds — the worst moment being right after payment.
  // loadSubscription() is async (fetch-based), so it doesn't block the
  // main thread. The SSR cookie hint (arena_tier) already handles hydration perf.
  useEffect(() => {
    if (auth.authChecked && (!initialSubscription || stateOwnerScopeKeyRef.current !== scopeKey)) {
      loadSubscription()
    }
  }, [auth.authChecked, initialSubscription, loadSubscription, scopeKey])

  // Run NFT check after subscription loads
  useEffect(() => {
    if (!isLoading) {
      checkNFTMembership()
    }
  }, [isLoading, checkNFTMembership])

  const scopedService = useMemo(() => serviceForSubscription(subscription), [subscription])
  const checkFeature = useCallback(
    (featureId: PremiumFeatureId): FeatureCheckResult => {
      return scopedService.checkFeatureAccess(featureId)
    },
    [scopedService]
  )

  const refresh = useCallback(async () => {
    await loadSubscription()
  }, [loadSubscription])

  const value = useMemo<PremiumContextValue>(() => {
    const actualIsPremium = subscription ? scopedService.isPremiumUser() : false
    // During open beta, all users get premium features unlocked
    const effectiveIsPremium = BETA_PRO_FEATURES_FREE || actualIsPremium
    return {
      subscription,
      isLoading,
      isPremium: effectiveIsPremium,
      isFeaturesUnlocked: effectiveIsPremium,
      tier: subscription?.tier || 'free',
      source: subscription?.paymentMethod === 'stripe' ? 'stripe' : 'free',
      hasNFT,
      checkFeature,
      refresh,
    }
  }, [subscription, isLoading, hasNFT, checkFeature, refresh, scopedService])

  return <PremiumContext.Provider value={value}>{children}</PremiumContext.Provider>
}

// ============================================
// Hooks
// ============================================

/**
 * Safe default for when usePremium is called outside PremiumProvider.
 * This happens when components (e.g. GoProButton in TopNav) mount before
 * Providers are loaded during SSR or Phase 1 rendering.
 */
const PREMIUM_DEFAULT: PremiumContextValue = {
  subscription: null,
  isLoading: true,
  isPremium: false,
  isFeaturesUnlocked: false,
  tier: 'free' as SubscriptionTier,
  source: 'free',
  hasNFT: false,
  checkFeature: () => ({ hasAccess: false, isLimitReached: false, remaining: 0 }),
  refresh: async () => {},
}

/**
 * 获取会员上下文
 */
export function usePremium(): PremiumContextValue {
  const context = useContext(PremiumContext)
  // Return safe default instead of throwing — components may render before
  // PremiumProvider loads (e.g. TopNav SSR, mobile GoProButton)
  return context ?? PREMIUM_DEFAULT
}

/**
 * 检查功能访问权限
 */
export function useFeatureAccess(
  featureId: PremiumFeatureId
): FeatureCheckResult & { isLoading: boolean } {
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
  const { subscription, isLoading } = usePremium()
  const service = useMemo(() => serviceForSubscription(subscription), [subscription])
  const result = service.checkFollowLimit()
  return { ...result, isLoading }
}

/**
 * 历史数据访问检查
 */
export function useHistoricalDataAccess(
  requestedDays: number
): FeatureCheckResult & { isLoading: boolean } {
  const { subscription, isLoading } = usePremium()
  const service = useMemo(() => serviceForSubscription(subscription), [subscription])
  const result = service.checkHistoricalDataAccess(requestedDays)
  return { ...result, isLoading }
}

/**
 * 升级建议
 */
export function useUpgradeSuggestion(): {
  suggestion: { targetTier: SubscriptionTier; message: string } | null
  isLoading: boolean
} {
  const { subscription, isLoading } = usePremium()
  const service = useMemo(() => serviceForSubscription(subscription), [subscription])
  const suggestion = service.getUpgradeSuggestion()
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
  const service = serviceForSubscription(subscription)

  // 根据功能 ID 获取对应的使用量和限制
  let used = 0
  let limit = 0

  switch (featureId) {
    case 'api_access':
      used = usage.apiCallsToday
      limit = service.checkFeatureAccess('api_access').remaining + used
      break
    case 'trader_comparison':
      used = usage.comparisonReportsThisMonth
      limit = service.checkFeatureAccess('trader_comparison').remaining + used
      break
    case 'export_data':
      used = usage.exportsThisMonth
      limit = service.checkFeatureAccess('export_data').remaining + used
      break
    case 'custom_rankings':
      used = usage.currentCustomRankings
      limit = service.checkFeatureAccess('custom_rankings').remaining + used
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
export function PremiumOnly({
  children,
  fallback = null,
}: {
  children: ReactNode
  fallback?: ReactNode
}) {
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
