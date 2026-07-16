'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { clearProStatusCache } from '@/lib/hooks/useProStatus'
import { logger } from '@/lib/logger'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

export default function LogoutPage() {
  const router = useRouter()
  const { signOut } = useAuthSession()
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const performLogout = async () => {
      try {
        // Clear all local state before signing out
        clearProStatusCache()

        // Clear app-specific localStorage keys (preserve onboarding/theme/language preferences)
        const keysToRemove = ['supabase.auth.token', 'sb-auth-token', 'guest-signup-dismissed']
        keysToRemove.forEach((key) => {
          try {
            localStorage.removeItem(key)
          } catch {
            /* ignore */
          }
        })

        // Clear all sessionStorage
        try {
          sessionStorage.clear()
        } catch {
          /* ignore */
        }

        await signOut()
      } catch (err) {
        logger.error('Logout error:', err)
      } finally {
        if (mountedRef.current) {
          router.push('/login')
        }
      }
    }

    performLogout()

    return () => {
      mountedRef.current = false
    }
  }, [router, signOut])

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        color: 'var(--color-text-secondary)',
      }}
    >
      Logging out...
    </div>
  )
}
