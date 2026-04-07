'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { logger } from '@/lib/logger'

// Lazy import supabase — @supabase/supabase-js is 167KB; keep it out of the
// initial bundle so it loads after FCP.
async function getSupabase() {
  const { supabase } = await import('@/lib/supabase/client')
  return supabase
}

// 缓存配置
const CACHE_TTL = 5 * 60 * 1000 // 5分钟

interface ProStatusCache {
  userId: string | null
  isPro: boolean
  plan: string | null
  expiresAt: string | null
  timestamp: number
}

const cache: ProStatusCache = {
  userId: null,
  isPro: false,
  plan: null,
  expiresAt: null,
  timestamp: 0,
}

export interface ProStatus {
  isPro: boolean
  plan: 'monthly' | 'yearly' | null
  expiresAt: string | null
  isLoading: boolean
  refresh: () => void
}

/**
 * 检查当前用户Pro会员状态
 * 优先查 subscriptions 表，备用 user_profiles.subscription_tier
 * 带5分钟缓存
 */
export function useProStatus(): ProStatus {
  const [isPro, setIsPro] = useState(false)
  const [plan, setPlan] = useState<'monthly' | 'yearly' | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const isMountedRef = useRef(true)

  const check = useCallback(async (force = false) => {
    try {
      const supabase = await getSupabase()
      // Use getSession() instead of getUser() — getSession() reads from local storage
      // while getUser() makes a network request to Supabase Auth server every time
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null

      if (!user) {
        if (isMountedRef.current) {
          setIsPro(false)
          setPlan(null)
          setExpiresAt(null)
          setIsLoading(false)
        }
        cache.userId = null
        cache.isPro = false
        cache.plan = null
        cache.expiresAt = null
        cache.timestamp = 0
        return
      }

      // 命中缓存
      const now = Date.now()
      if (!force && cache.userId === user.id && now - cache.timestamp < CACHE_TTL) {
        if (isMountedRef.current) {
          setIsPro(cache.isPro)
          setPlan(cache.plan as 'monthly' | 'yearly' | null)
          setExpiresAt(cache.expiresAt)
          setIsLoading(false)
        }
        return
      }

      // 查 subscriptions 表
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('tier, status, plan, current_period_end')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // 备用：user_profiles (check both is_pro and subscription_tier)
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier, is_pro')
        .eq('id', user.id)
        .maybeSingle()

      let finalIsPro = false
      let finalPlan: string | null = null
      let finalExpires: string | null = null

      if (sub && (sub.tier === 'pro' || sub.status === 'active' || sub.status === 'trialing')) {
        finalIsPro = sub.tier === 'pro'
        finalPlan = sub.plan || null
        finalExpires = sub.current_period_end || null
      } else if (profile?.is_pro === true || profile?.subscription_tier === 'pro') {
        finalIsPro = true
      }

      // 更新缓存
      cache.userId = user.id
      cache.isPro = finalIsPro
      cache.plan = finalPlan
      cache.expiresAt = finalExpires
      cache.timestamp = now

      if (isMountedRef.current) {
        setIsPro(finalIsPro)
        setPlan(finalPlan as 'monthly' | 'yearly' | null)
        setExpiresAt(finalExpires)
      }
    } catch (err) {
      logger.error('Error checking pro status:', err)
      if (isMountedRef.current) {
        setIsPro(false)
        setPlan(null)
        setExpiresAt(null)
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [])

  const refresh = useCallback(() => check(true), [check])

  useEffect(() => {
    isMountedRef.current = true
    check()

    let unsubscribe: (() => void) | undefined

    getSupabase().then((supabase) => {
      if (!isMountedRef.current) return
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
          check(true)
        }
      })
      unsubscribe = () => subscription.unsubscribe()
    }).catch((err) => logger.error('useProStatus: failed to load supabase', err))

    return () => {
      isMountedRef.current = false
      unsubscribe?.()
    }
  }, [check])

  return { isPro, plan, expiresAt, isLoading, refresh }
}

/** 清除缓存（支付成功后调用） */
export function clearProStatusCache() {
  cache.userId = null
  cache.isPro = false
  cache.plan = null
  cache.expiresAt = null
  cache.timestamp = 0
}
