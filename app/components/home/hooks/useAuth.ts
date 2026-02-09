'use client'

/**
 * Thin wrapper around useAuthSession for home page components.
 * @deprecated Use useAuthSession() directly for new code.
 */

import { useAuthSession } from '@/lib/hooks/useAuthSession'

export function useAuth() {
  const { email, isLoggedIn, loading } = useAuthSession()

  return {
    email,
    isLoggedIn,
    loading,
  }
}
