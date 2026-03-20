'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { logger } from '@/lib/logger'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'

// Lazy-load Supabase to keep it out of the initial client bundle
const getSupabase = () => import('@/lib/supabase/client').then(m => m.supabase)

// 缓存配置
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存
const cache: {
  userId: string | null
  isPro: boolean
  timestamp: number
} = {
  userId: null,
  isPro: false,
  timestamp: 0,
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
  const [isPro, setIsPro] = useState(BETA_PRO_FEATURES_FREE)
  const [isLoading, setIsLoading] = useState(!BETA_PRO_FEATURES_FREE)
  const [tier, setTier] = useState<string>(BETA_PRO_FEATURES_FREE ? 'pro' : 'free')
  const isMountedRef = useRef(true)

  const checkSubscription = useCallback(async (forceRefresh = false) => {
    // During beta, skip all Supabase queries
    if (BETA_PRO_FEATURES_FREE) return

    try {
      // Use getSession() — reads from local storage instead of making a network request
      const supabase = await getSupabase()
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null

      if (!user) {
        if (isMountedRef.current) {
          setIsPro(false)
          setTier('free')
          setIsLoading(false)
        }
        // 清除缓存
        cache.userId = null
        cache.isPro = false
        cache.timestamp = 0
        return
      }

      // 检查缓存是否有效
      const now = Date.now()
      if (
        !forceRefresh &&
        cache.userId === user.id &&
        now - cache.timestamp < CACHE_TTL
      ) {
        if (isMountedRef.current) {
          setIsPro(cache.isPro)
          setTier(cache.isPro ? 'pro' : 'free')
          setIsLoading(false)
        }
        return
      }

      // 方法1: 检查 subscriptions 表（优先）
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('tier, status')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing']) // 包括试用状态
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 方法2: 检查 user_profiles.subscription_tier 作为备用
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .maybeSingle()

      // 优先使用 subscriptions 表的结果，如果没有则使用 user_profiles
      let finalTier: 'free' | 'pro' = 'free'
      let isPro = false

      if (subscription && (subscription.tier === 'pro' || subscription.status === 'active' || subscription.status === 'trialing')) {
        finalTier = subscription.tier as 'free' | 'pro'
        isPro = finalTier === 'pro'
      } else if (profile?.subscription_tier === 'pro') {
        // subscriptions 表可能还没更新（webhook 延迟），使用 user_profiles 作为备用
        finalTier = 'pro'
        isPro = true
      }

      // 更新缓存
      cache.userId = user.id
      cache.isPro = isPro
      cache.timestamp = now

      if (isMountedRef.current) {
        setIsPro(isPro)
        setTier(finalTier)
      }
    } catch (error) {
      logger.error('Error checking subscription:', error)
      if (isMountedRef.current) {
        setIsPro(false)
        setTier('free')
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [])

  // 强制刷新订阅状态（用于支付成功后）
  const refresh = useCallback(() => {
    checkSubscription(true)
  }, [checkSubscription])

  useEffect(() => {
    // During beta, no need to check subscription or listen to auth changes
    if (BETA_PRO_FEATURES_FREE) return

    isMountedRef.current = true
    checkSubscription()

    // 监听登录状态变化 (lazy-load supabase)
    let authSub: { unsubscribe: () => void } | null = null
    getSupabase().then((supabase) => {
      if (!isMountedRef.current) return
      const { data } = supabase.auth.onAuthStateChange((event) => {
        // 登录或登出时强制刷新
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          checkSubscription(true)
        }
      })
      authSub = data.subscription
    })

    return () => {
      isMountedRef.current = false
      authSub?.unsubscribe()
    }
  }, [checkSubscription])

  // isFeaturesUnlocked: beta 期间全员解锁；正式收费后等于 isPro
  // During open beta, treat all users as Pro so no UI gates are shown
  const effectiveIsPro = BETA_PRO_FEATURES_FREE || isPro
  return { isPro: effectiveIsPro, isLoading, tier, refresh, isFeaturesUnlocked: true }
}

// 清除缓存的工具函数（用于支付成功后）
export function clearSubscriptionCache() {
  cache.userId = null
  cache.isPro = false
  cache.timestamp = 0
}
