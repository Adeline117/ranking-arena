'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { Suspense } from 'react'
import { logger } from '@/lib/logger'

function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const handleCallback = async () => {
      const { data: { session }, error } = await supabase.auth.getSession()

      if (error) {
        logger.error('Auth callback error:', error)
        router.replace('/login?error=auth_failed')
        return
      }

      const returnUrl = searchParams.get('returnUrl')
      const redirect = returnUrl && returnUrl.startsWith('/') ? returnUrl : '/'

      if (session) {
        router.replace(redirect)
      } else {
        // Wait a moment for supabase to process the hash fragment
        setTimeout(async () => {
          const { data: { session: retrySession } } = await supabase.auth.getSession()
          if (retrySession) {
            router.replace(redirect)
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
          Logging in...
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
