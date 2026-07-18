'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { getAuthSession, refreshAuthToken } from '@/lib/auth'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { fireAndForget } from '@/lib/utils/logger'
import { buildConversationLoginHref } from '../login-intent'

export function useConversationAuth(conversationId: string) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getAuthSession()
      .then((auth) => {
        if (cancelled) return
        if (auth) {
          setUserId(auth.userId)
          setAccessToken(auth.accessToken)
          fireAndForget(
            supabase.auth.getSession().then(({ data }) => {
              if (cancelled) return
              setEmail(data.session?.user?.email ?? null)
            }),
            'conversation-auth-email'
          )
        } else {
          setUserId(null)
          setAccessToken(null)
        }
      })
      .catch(() => {
        if (cancelled) return
        setUserId(null)
        setEmail(null)
        setAccessToken(null)
      })
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUserId(session.user.id)
        setEmail(session.user.email ?? null)
        setAccessToken(session.access_token)
      } else {
        setUserId(null)
        setEmail(null)
        setAccessToken(null)
      }
    })
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const ensureAuth = useCallback(async (): Promise<{
    userId: string
    accessToken: string
  } | null> => {
    const auth = await getAuthSession()
    if (auth) return auth
    const refreshed = await refreshAuthToken()
    if (refreshed) return refreshed
    showToast(t('loginExpiredPleaseRelogin'), 'error')
    router.push(buildConversationLoginHref(conversationId))
    return null
  }, [conversationId, showToast, t, router])

  return { email, userId, authChecked, accessToken, ensureAuth }
}
