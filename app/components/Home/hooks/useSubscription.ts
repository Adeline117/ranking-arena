'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

/**
 * 简单的订阅状态 hook - 不需要 Provider
 * 检查 subscriptions 表和 user_profiles.subscription_tier
 */
export function useSubscription() {
  const [isPro, setIsPro] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const checkSubscription = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        
        if (!user) {
          setIsPro(false)
          setIsLoading(false)
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
          setIsPro(true)
          setIsLoading(false)
          return
        }

        // 方法2: 检查 user_profiles.subscription_tier 作为备用
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('subscription_tier')
          .eq('id', user.id)
          .maybeSingle()

        if (profile && ['pro', 'elite', 'enterprise'].includes(profile.subscription_tier)) {
          setIsPro(true)
        } else {
          setIsPro(false)
        }
      } catch (error) {
        console.error('Error checking subscription:', error)
        setIsPro(false)
      } finally {
        setIsLoading(false)
      }
    }

    checkSubscription()

    // 监听登录状态变化
    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange(() => {
      checkSubscription()
    })

    return () => {
      authSub.unsubscribe()
    }
  }, [])

  return { isPro, isLoading }
}
