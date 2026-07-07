'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { logger } from '@/lib/logger'
import { getGlobalToast } from '@/lib/hooks/useApiMutation'
import { t } from '@/lib/i18n'

// Admin check is done via database role in user_profiles.role
// This prevents exposing admin emails in the client bundle

export function useAdminAuth() {
  const router = useRouter()
  const pathname = usePathname()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [authChecking, setAuthChecking] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; checkAuth uses router/supabase which are stable
  }, [])

  async function checkAuth() {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.user) {
        router.push(`/login?returnUrl=${encodeURIComponent(pathname)}`)
        return
      }

      setEmail(session.user.email ?? null)
      setAccessToken(session.access_token)
      setUserId(session.user.id)

      // Check admin status via database role (secure, server-validated)
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', session.user.id)
        .maybeSingle()

      if (profile?.role !== 'admin') {
        // Not an admin: tell them why before redirecting (was a silent bounce
        // to the homepage — confusing for internal staff who mis-click).
        getGlobalToast()?.(t('u13admin_accessRequired'), 'error')
        router.push('/')
        return
      }

      setIsAdmin(true)
      setAuthChecking(false)
    } catch (error) {
      logger.error('Auth check failed:', error)
      router.push(`/login?returnUrl=${encodeURIComponent(pathname)}`)
    }
  }

  return {
    email,
    accessToken,
    isAdmin,
    authChecking,
    userId,
  }
}
