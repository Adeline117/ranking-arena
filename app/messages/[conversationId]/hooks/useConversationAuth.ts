'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { getAuthSession, refreshAuthToken } from '@/lib/auth'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export function useConversationAuth() {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)

  useEffect(() => {
    getAuthSession().then((auth) => {
      if (auth) {
        setUserId(auth.userId)
        setAccessToken(auth.accessToken)
        supabase.auth.getSession().then(({ data }) => {
          setEmail(data.session?.user?.email ?? null)
        }).catch(() => { /* Intentionally swallowed: email fetch non-critical */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
      } else {
        setUserId(null)
        setAccessToken(null)
      }
      setAuthChecked(true)
    }).catch(() => { /* Intentionally swallowed: auth session check non-critical */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
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
    return () => { subscription.unsubscribe() }
  }, [])

  const ensureAuth = useCallback(async (): Promise<{ userId: string; accessToken: string } | null> => {
    const auth = await getAuthSession()
    if (auth) return auth
    const refreshed = await refreshAuthToken()
    if (refreshed) return refreshed
    showToast(t('loginExpiredPleaseRelogin'), 'error')
    router.push('/login?redirect=/inbox')
    return null
  }, [showToast, t, router])

  return { email, userId, authChecked, accessToken, ensureAuth }
}
