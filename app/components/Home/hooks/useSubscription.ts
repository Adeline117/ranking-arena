'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

/**
 * 简单的订阅状态 hook - 不需要 Provider
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

        // 检查订阅状态
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', user.id)
          .eq('status', 'active')
          .maybeSingle()

        if (subscription && ['pro', 'elite', 'enterprise'].includes(subscription.tier)) {
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
