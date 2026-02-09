'use client'

/**
 * useUnifiedAuth - Thin compatibility wrapper around useAuthSession
 * 
 * DEPRECATED: Prefer useAuthSession directly for new code.
 * This wrapper exists for components that use the UnifiedAuth API shape
 * (isAuthenticated, requireAuth() returning token string, etc.)
 */

import { useCallback, useMemo } from 'react'
import { useAuthSession } from './useAuthSession'
import type { AuthSessionReturn } from './useAuthSession'

export type UnifiedAuth = {
  user: AuthSessionReturn['user']
  userId: string | null
  email: string | null
  accessToken: string | null
  initialized: boolean
  isAuthenticated: boolean
  walletAddress: string | null
  isWalletUser: boolean
  requireAuth: () => string | null
  getAuthHeaders: () => Record<string, string>
  signOut: () => Promise<void>
  refreshSession: () => Promise<string | null>
}

/**
 * @deprecated Use useAuthSession() instead
 */
export function useUnifiedAuth(options?: {
  onUnauthenticated?: () => void
}): UnifiedAuth {
  const auth = useAuthSession()

  const requireAuth = useCallback((): string | null => {
    if (!auth.isLoggedIn || !auth.accessToken) {
      options?.onUnauthenticated?.()
      return null
    }
    return auth.accessToken
  }, [auth.isLoggedIn, auth.accessToken, options])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!auth.accessToken) return {}
    return { 'Authorization': `Bearer ${auth.accessToken}` }
  }, [auth.accessToken])

  const refreshSessionCompat = useCallback(async (): Promise<string | null> => {
    const ok = await auth.refreshSession()
    if (!ok) return null
    // After refresh, the global state has the new token
    return auth.accessToken
  }, [auth])

  const walletAddress = (auth.user?.user_metadata?.wallet_address as string) ?? null
  const isWalletUser = !!walletAddress || (auth.email?.endsWith('@wallet.arena') ?? false)

  return useMemo(() => ({
    user: auth.user,
    userId: auth.userId,
    email: auth.email,
    accessToken: auth.accessToken,
    initialized: auth.authChecked,
    isAuthenticated: auth.isLoggedIn,
    walletAddress,
    isWalletUser,
    requireAuth,
    getAuthHeaders,
    signOut: auth.signOut,
    refreshSession: refreshSessionCompat,
  }), [auth.user, auth.userId, auth.email, auth.accessToken, auth.authChecked, auth.isLoggedIn, walletAddress, isWalletUser, requireAuth, getAuthHeaders, auth.signOut, refreshSessionCompat])
}
