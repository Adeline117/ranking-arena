'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Suspense } from 'react'
import { logger } from '@/lib/logger'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useMultiAccountStore } from '@/lib/stores/multiAccountStore'

function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t, language: _language } = useLanguage()

  useEffect(() => {
    const handleCallback = async () => {
      const { data: { session }, error } = await supabase.auth.getSession()

      if (error) {
        logger.error('Auth callback error:', error)
        router.replace('/login?error=auth_failed')
        return
      }

      const isAddAccount = searchParams.get('addAccount') === 'true' || (typeof window !== 'undefined' && (() => { try { return localStorage.getItem('arena_adding_account') === 'true' } catch { return false } })())
      // Don't clear flag yet — wait until saveToStore succeeds

      const returnUrl = searchParams.get('returnUrl')
      // Validate returnUrl: must start with / but NOT // (prevents protocol-relative open redirect)
      const isSafeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//')
      const defaultRedirect = isAddAccount ? '/' : (isSafeReturn ? returnUrl : '/')

      // Save new account to multi-account store
      const saveToStore = async (sess: typeof session) => {
        if (!isAddAccount || !sess) return
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('handle, avatar_url')
          .eq('id', user.id)
          .maybeSingle()
        const store = useMultiAccountStore.getState()
        store.accounts.forEach((a) => {
          if (a.isActive) store.addAccount({ ...a, isActive: false })
        })
        store.addAccount({
          userId: user.id,
          email: user.email || '',
          handle: profile?.handle || null,
          avatarUrl: profile?.avatar_url || null,
          refreshToken: sess.refresh_token,
          lastActiveAt: new Date().toISOString(),
          isActive: true,
        })
      }

      if (session) {
        // Sync OAuth avatar to user_profiles if not already set
        try {
          const meta = session.user.user_metadata
          const oauthAvatar = meta?.avatar_url || meta?.picture || null
          if (oauthAvatar) {
            const { data: profile } = await supabase
              .from('user_profiles')
              .select('id, avatar_url, handle')
              .eq('id', session.user.id)
              .maybeSingle()

            if (profile && (!profile.avatar_url || profile.avatar_url.length < 5)) {
              // Profile exists but no avatar (or invalid) — sync from OAuth
              await supabase
                .from('user_profiles')
                .update({ avatar_url: oauthAvatar })
                .eq('id', session.user.id)
            } else if (!profile) {
              // No profile yet — create one with avatar
              const emailHandle = session.user.email?.split('@')[0] || session.user.id.slice(0, 8)
              await supabase
                .from('user_profiles')
                .upsert({
                  id: session.user.id,
                  email: session.user.email || '',
                  handle: emailHandle,
                  avatar_url: oauthAvatar,
                }, { onConflict: 'id' })
            }
          }
        } catch (err) {
          logger.warn('Failed to sync OAuth avatar:', err)
        }

        await saveToStore(session)
        if (isAddAccount) try { localStorage.removeItem('arena_adding_account') } catch { /* intentional */ }
        // Check if this is a new user (created within the last 30 seconds)
        const createdAt = new Date(session.user.created_at).getTime()
        const now = Date.now()
        const isNewUser = now - createdAt < 30_000

        // New users → homepage with welcome banner (skip complex onboarding)
        router.replace(isAddAccount ? '/' : (isNewUser ? '/?welcome=1' : defaultRedirect))
      } else {
        // Wait a moment for supabase to process the hash fragment
        setTimeout(async () => {
          const { data: { session: retrySession } } = await supabase.auth.getSession()
          if (retrySession) {
            await saveToStore(retrySession)
            if (isAddAccount) try { localStorage.removeItem('arena_adding_account') } catch { /* intentional */ }
            const createdAt = new Date(retrySession.user.created_at).getTime()
            const now = Date.now()
            const isNewUser = now - createdAt < 30_000
            const onboardingDest2 = isSafeReturn ? `/onboarding?returnUrl=${encodeURIComponent(returnUrl!)}` : '/onboarding'
            router.replace(isAddAccount ? '/' : (isNewUser ? onboardingDest2 : defaultRedirect))
          } else {
            router.replace('/login?error=no_session')
          }
        }, 1000)
      }
    }

    handleCallback()
  }, [router, searchParams])

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary,
    }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 32, height: 32,
          border: `3px solid ${tokens.colors.accent.primary}`,
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          margin: '0 auto 16px',
        }} />
        <p style={{ color: tokens.colors.text.secondary, fontSize: 14 }}>
          {t('signingIn')}
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.colors.bg.primary,
      }}>
        <div style={{
          width: 32, height: 32,
          border: `3px solid ${tokens.colors.accent.primary}`,
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
      </div>
    }>
      <AuthCallbackContent />
    </Suspense>
  )
}
