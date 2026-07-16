'use client'

import { useEffect, useCallback, useMemo, useRef } from 'react'
import { logger } from '@/lib/logger'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'

// Lazy-load Supabase to keep it out of the initial client bundle
const getSupabase = () => import('@/lib/supabase/client').then((m) => m.supabase)

// 缓存配置
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存
const cache: {
  ownerKey: string | null
  userId: string | null
  isPro: boolean
  tier: string
  timestamp: number
} = {
  ownerKey: null,
  userId: null,
  isPro: false,
  tier: 'free',
  timestamp: 0,
}

type SubscriptionState = {
  isPro: boolean
  isLoading: boolean
  tier: string
}

function subscriptionOwnerKey(scope: ViewerScope): string {
  return `subscription:${JSON.stringify([scope.userId, scope.viewerKey, scope.sessionGeneration])}`
}

function isSameViewerScope(left: ViewerScope, right: ViewerScope): boolean {
  return (
    left.userId === right.userId &&
    left.viewerKey === right.viewerKey &&
    left.sessionGeneration === right.sessionGeneration
  )
}

function resetCache(): void {
  cache.ownerKey = null
  cache.userId = null
  cache.isPro = false
  cache.tier = 'free'
  cache.timestamp = 0
}

/**
 * 简单的订阅状态 hook - 带缓存机制
 * 检查 subscriptions 表和 user_profiles.subscription_tier
 * 缓存有效期 5 分钟，减少重复请求
 *
 * When BETA_PRO_FEATURES_FREE is true, returns isPro: true immediately
 * without making any Supabase queries (all hooks still called to satisfy rules-of-hooks).
 */
export function useSubscription() {
  const auth = useAuthSession()
  const viewerScope: ViewerScope = useMemo(
    () => ({
      userId: auth.userId,
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
    }),
    [auth.sessionGeneration, auth.userId, auth.viewerKey]
  )
  const ownerKey = subscriptionOwnerKey(viewerScope)
  const [subscriptionState, setSubscriptionState] = useViewerSlotState<SubscriptionState>(
    ownerKey,
    {
      isPro: BETA_PRO_FEATURES_FREE,
      isLoading: !BETA_PRO_FEATURES_FREE,
      tier: BETA_PRO_FEATURES_FREE ? 'pro' : 'free',
    }
  )
  const mountedRef = useRef(true)
  const viewerScopeRef = useRef(viewerScope)
  const ownerKeyRef = useRef(ownerKey)
  const requestRevisionRef = useRef(0)
  viewerScopeRef.current = viewerScope
  ownerKeyRef.current = ownerKey

  const isCurrentScope = useCallback((expected: ViewerScope, expectedOwnerKey: string) => {
    return (
      mountedRef.current &&
      ownerKeyRef.current === expectedOwnerKey &&
      isSameViewerScope(expected, viewerScopeRef.current) &&
      isViewerScopeCurrent(expected)
    )
  }, [])

  const checkSubscription = useCallback(
    async (forceRefresh = false) => {
      // During beta, skip all Supabase queries
      if (BETA_PRO_FEATURES_FREE) return

      const expectedScope = viewerScope
      const expectedOwnerKey = ownerKey
      const requestRevision = requestRevisionRef.current + 1
      requestRevisionRef.current = requestRevision
      const requestIsCurrent = () =>
        requestRevisionRef.current === requestRevision &&
        isCurrentScope(expectedScope, expectedOwnerKey)

      if (!requestIsCurrent()) return
      if (expectedScope.viewerKey === 'pending') {
        setSubscriptionState({ isPro: false, isLoading: true, tier: 'free' })
        return
      }
      if (expectedScope.viewerKey === 'anon' || !expectedScope.userId) {
        resetCache()
        setSubscriptionState({ isPro: false, isLoading: false, tier: 'free' })
        return
      }

      const expectedUserId = expectedScope.userId
      try {
        // Use getSession() — reads from local storage instead of making a network request
        const supabase = await getSupabase()
        if (!requestIsCurrent()) return
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession()
        if (!requestIsCurrent()) return
        if (sessionError) throw sessionError
        if (session?.user.id !== expectedUserId) {
          throw new Error('Subscription session did not match the current viewer')
        }

        // 检查缓存是否有效
        const now = Date.now()
        if (
          !forceRefresh &&
          cache.ownerKey === expectedOwnerKey &&
          cache.userId === expectedUserId &&
          now - cache.timestamp < CACHE_TTL
        ) {
          setSubscriptionState({
            isPro: cache.isPro,
            isLoading: false,
            tier: cache.tier,
          })
          return
        }

        // 方法1: 检查 subscriptions 表（优先）
        const { data: subscription, error: subscriptionError } = await supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', expectedUserId)
          .in('status', ['active', 'trialing']) // 包括试用状态
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!requestIsCurrent()) return
        if (subscriptionError) throw subscriptionError

        // 方法2: 检查 user_profiles.subscription_tier 作为备用
        const { data: profile, error: profileError } = await supabase
          .from('user_profiles')
          .select('subscription_tier')
          .eq('id', expectedUserId)
          .maybeSingle()
        if (!requestIsCurrent()) return
        if (profileError) throw profileError

        // 优先使用 subscriptions 表的结果，如果没有则使用 user_profiles
        let finalTier: 'free' | 'pro' = 'free'
        let isPro = false

        if (
          subscription &&
          (subscription.tier === 'pro' ||
            subscription.status === 'active' ||
            subscription.status === 'trialing')
        ) {
          finalTier = subscription.tier as 'free' | 'pro'
          isPro = finalTier === 'pro'
        } else if (profile?.subscription_tier === 'pro') {
          // subscriptions 表可能还没更新（webhook 延迟），使用 user_profiles 作为备用
          finalTier = 'pro'
          isPro = true
        }

        if (!requestIsCurrent()) return
        // 更新缓存；cache identity includes the exact viewer/session owner.
        cache.ownerKey = expectedOwnerKey
        cache.userId = expectedUserId
        cache.isPro = isPro
        cache.tier = finalTier
        cache.timestamp = now
        setSubscriptionState({ isPro, isLoading: false, tier: finalTier })
      } catch (error) {
        if (!requestIsCurrent()) return
        logger.error('Error checking subscription:', error)
        if (cache.ownerKey === expectedOwnerKey) resetCache()
        setSubscriptionState({ isPro: false, isLoading: false, tier: 'free' })
      } finally {
        if (requestIsCurrent()) {
          setSubscriptionState((previous) => ({ ...previous, isLoading: false }))
        }
      }
    },
    [isCurrentScope, ownerKey, setSubscriptionState, viewerScope]
  )

  // 强制刷新订阅状态（用于支付成功后）
  const refresh = useCallback(() => {
    void checkSubscription(true)
  }, [checkSubscription])

  useEffect(() => {
    // During beta, no need to check subscription or listen to auth changes
    if (BETA_PRO_FEATURES_FREE) return

    const expectedScope = viewerScope
    const expectedOwnerKey = ownerKey
    let active = true
    const effectIsCurrent = () => active && isCurrentScope(expectedScope, expectedOwnerKey)
    void checkSubscription()

    // 监听登录状态变化 (lazy-load supabase)
    let authSub: { unsubscribe: () => void } | null = null
    void getSupabase()
      .then((supabase) => {
        if (!effectIsCurrent()) return
        const { data } = supabase.auth.onAuthStateChange((event) => {
          // 登录或登出时强制刷新
          if (effectIsCurrent() && (event === 'SIGNED_IN' || event === 'SIGNED_OUT')) {
            void checkSubscription(true)
          }
        })
        if (!effectIsCurrent()) {
          data.subscription.unsubscribe()
          return
        }
        authSub = data.subscription
      })
      .catch((error) => {
        if (effectIsCurrent()) logger.error('Error subscribing to auth state:', error)
      })

    return () => {
      active = false
      authSub?.unsubscribe()
    }
  }, [checkSubscription, isCurrentScope, ownerKey, viewerScope])

  useEffect(
    () => () => {
      mountedRef.current = false
      requestRevisionRef.current += 1
    },
    []
  )

  // isFeaturesUnlocked: beta 期间全员解锁；正式收费后等于 isPro
  // During open beta, treat all users as Pro so no UI gates are shown
  const effectiveIsPro = BETA_PRO_FEATURES_FREE || subscriptionState.isPro
  return {
    isPro: effectiveIsPro,
    isLoading: subscriptionState.isLoading,
    tier: subscriptionState.tier,
    refresh,
    isFeaturesUnlocked: effectiveIsPro,
  }
}

// 清除缓存的工具函数（用于支付成功后）
export function clearSubscriptionCache() {
  resetCache()
}
