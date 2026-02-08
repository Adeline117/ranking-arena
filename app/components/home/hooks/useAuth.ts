'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase/client'

export function useAuth() {
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoading(false)
    })

    // 订阅认证状态变化
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return {
    email,
    isLoggedIn: !!email,
    loading,
  }
}
