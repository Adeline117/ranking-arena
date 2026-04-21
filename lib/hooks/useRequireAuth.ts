'use client'

/**
 * useRequireAuth — Centralized auth guard hook for protected pages.
 *
 * Replaces ad-hoc "if not logged in, redirect to /login" patterns scattered
 * across pages like /notifications, /settings, /inbox, etc.
 *
 * Features:
 * - Automatically appends `returnUrl` so the user returns after login
 * - Waits for auth check to complete before redirecting (avoids flash)
 * - Returns { isLoggedIn, isLoading } for render gating
 *
 * Usage:
 *   const { isLoggedIn, isLoading } = useRequireAuth()
 *   if (isLoading || !isLoggedIn) return <LoadingSkeleton />
 */

import { useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useAuthSession } from './useAuthSession'

export function useRequireAuth() {
  const { isLoggedIn, loading, authChecked } = useAuthSession()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (!authChecked || loading) return
    if (!isLoggedIn) {
      const qs = searchParams.toString()
      const returnUrl = pathname + (qs ? '?' + qs : '')
      router.replace(`/login?returnUrl=${encodeURIComponent(returnUrl)}`)
    }
  }, [isLoggedIn, loading, authChecked, pathname, searchParams, router])

  return { isLoggedIn, isLoading: loading || !authChecked }
}
