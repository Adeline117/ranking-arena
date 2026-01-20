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

      // 方法1: 检查 subscriptions 表
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('tier, status')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle()

      if (subscription && ['pro', 'elite', 'enterprise'].includes(subscription.tier)) {
        // 更新缓存
        cache.userId = user.id
        cache.isPro = true
        cache.timestamp = now
        
        if (isMountedRef.current) {
          setIsPro(true)
          setTier(subscription.tier)
          setIsLoading(false)
        }
        return
      }

      // 方法2: 检查 user_profiles.subscription_tier 作为备用
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .maybeSingle()

      const hasPro = profile && ['pro', 'elite', 'enterprise'].includes(profile.subscription_tier)
      
      // 更新缓存
      cache.userId = user.id
      cache.isPro = hasPro || false
      cache.timestamp = now
      
      if (isMountedRef.current) {
        setIsPro(hasPro || false)
        setTier(profile?.subscription_tier || 'free')
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
