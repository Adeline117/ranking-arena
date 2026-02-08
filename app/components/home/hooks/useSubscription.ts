'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'

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
 */
export function useSubscription() {
  const [isPro, setIsPro] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [tier, setTier] = useState<string>('free')
  const isMountedRef = useRef(true)

  const checkSubscription = useCallback(async (forceRefresh = false) => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
      const { data: { user } } = await supabase.auth.getUser()
      
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
      console.error('Error checking subscription:', error)
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
    isMountedRef.current = true
    checkSubscription()

    // 监听登录状态变化
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange((event) => {
      // 登录或登出时强制刷新
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
        checkSubscription(true)
      }
    })

    return () => {
      isMountedRef.current = false
      authSub.unsubscribe()
    }
  }, [checkSubscription])

  return { isPro, isLoading, tier, refresh }
}

// 清除缓存的工具函数（用于支付成功后）
export function clearSubscriptionCache() {
  cache.userId = null
  cache.isPro = false
  cache.timestamp = 0
}
