'use client'

import { useEffect, useCallback, useMemo, useRef } from 'react'
import { logger } from '@/lib/logger'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { isViewerScopeCurrent, type ViewerScope } from '@/lib/auth/viewer-scope'
import { useViewerSlotState } from '@/lib/groups/use-viewer-slot-state'
import { fetchVerifiedSubscription } from '@/lib/premium/subscription-client'

// 缓存配置
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存
const cache: {
  ownerKey: string | null
  userId: string | null
  isPro: boolean
  tier: 'free' | 'pro'
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
  tier: 'free' | 'pro'
  error: string | null
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
 * 只读取 /api/subscription 返回的服务端权威结果
 * 缓存有效期 5 分钟，减少重复请求
 *
 * When BETA_PRO_FEATURES_FREE is true, returns isPro: true immediately
 * without making an authority request (all hooks still called to satisfy rules-of-hooks).
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
      error: null,
    }
  )
  const mountedRef = useRef(true)
  const viewerScopeRef = useRef(viewerScope)
  const ownerKeyRef = useRef(ownerKey)
  const requestRevisionRef = useRef(0)
  viewerScopeRef.current = viewerScope
  ownerKeyRef.current = ownerKey

  useEffect(() => {
    // React StrictMode replays effect setup after cleanup in development.
    // Re-open this exact mounted lifetime before later effects start work.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRevisionRef.current += 1
    }
  }, [])

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
      // During beta, skip the subscription authority request.
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
        setSubscriptionState({ isPro: false, isLoading: true, tier: 'free', error: null })
        return
      }
      if (expectedScope.viewerKey === 'anon' || !expectedScope.userId) {
        resetCache()
        setSubscriptionState({ isPro: false, isLoading: false, tier: 'free', error: null })
        return
      }

      const expectedUserId = expectedScope.userId
      try {
        setSubscriptionState((previous) => ({ ...previous, isLoading: true, error: null }))
        const expectedAccessToken = auth.accessToken
        if (!expectedAccessToken) {
          throw new Error('Subscription access token is missing for the current viewer')
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
            tier: cache.tier === 'pro' ? 'pro' : 'free',
            error: null,
          })
          return
        }

        const subscription = await fetchVerifiedSubscription(expectedAccessToken, expectedUserId)
        if (!requestIsCurrent()) return
        const finalTier = subscription.tier
        const isPro = finalTier === 'pro'

        if (!requestIsCurrent()) return
        // 更新缓存；cache identity includes the exact viewer/session owner.
        cache.ownerKey = expectedOwnerKey
        cache.userId = expectedUserId
        cache.isPro = isPro
        cache.tier = finalTier
        cache.timestamp = now
        setSubscriptionState({ isPro, isLoading: false, tier: finalTier, error: null })
      } catch (error) {
        if (!requestIsCurrent()) return
        logger.error('Error checking subscription:', error)
        const authorityError = 'Unable to verify subscription. Retry to refresh your access.'
        if (cache.ownerKey === expectedOwnerKey && cache.userId === expectedUserId) {
          setSubscriptionState({
            isPro: cache.isPro,
            isLoading: false,
            tier: cache.tier === 'pro' ? 'pro' : 'free',
            error: authorityError,
          })
        } else {
          // No same-viewer last-good state exists. Keep the entitlement unknown
          // instead of inventing a successful Free response.
          setSubscriptionState({
            isPro: false,
            isLoading: false,
            tier: 'free',
            error: authorityError,
          })
        }
      } finally {
        if (requestIsCurrent()) {
          setSubscriptionState((previous) => ({ ...previous, isLoading: false }))
        }
      }
    },
    [auth.accessToken, isCurrentScope, ownerKey, setSubscriptionState, viewerScope]
  )

  // 强制刷新订阅状态（用于支付成功后）
  const refresh = useCallback(() => {
    void checkSubscription(true)
  }, [checkSubscription])

  useEffect(() => {
    // During beta, no need to check subscription or listen to auth changes
    if (BETA_PRO_FEATURES_FREE) return

    void checkSubscription()
  }, [checkSubscription])

  // isFeaturesUnlocked: beta 期间全员解锁；正式收费后等于 isPro
  // During open beta, treat all users as Pro so no UI gates are shown
  const effectiveIsPro = BETA_PRO_FEATURES_FREE || subscriptionState.isPro
  return {
    isPro: effectiveIsPro,
    isLoading: subscriptionState.isLoading,
    tier: subscriptionState.tier,
    error: subscriptionState.error,
    refresh,
    isFeaturesUnlocked: effectiveIsPro,
  }
}

// 清除缓存的工具函数（用于支付成功后）
export function clearSubscriptionCache() {
  resetCache()
}
