'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'

export default function AuthCallbackPage() {
  const router = useRouter()

  useEffect(() => {
    // Supabase implicit flow: the hash fragment contains auth tokens
    // supabase-js automatically detects and processes them
    const handleCallback = async () => {
      const { data: { session }, error } = await supabase.auth.getSession()
      
      if (error) {
        console.error('Auth callback error:', error)
        router.replace('/login?error=auth_failed')
        return
      }

      if (session) {
        router.replace('/')
      } else {
        // Wait a moment for supabase to process the hash
        setTimeout(async () => {
          const { data: { session: retrySession } } = await supabase.auth.getSession()
          if (retrySession) {
            router.replace('/')
          } else {
            router.replace('/login?error=no_session')
          }
        }, 1000)
      }
    }

    handleCallback()
  }, [router])

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
          正在登录...
        </p>
      </div>
    </div>
  )
}
