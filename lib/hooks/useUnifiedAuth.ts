'use client'

/**
 * Unified Auth Hook - Single Source of Truth for client-side authentication
 *
 * PRINCIPLES:
 * 1. Only one auth state source: Supabase session
 * 2. Provides user, userId, token, email, loading
 * 3. requireAuth() guard: prevents requests if not authenticated
 * 4. Token refresh is handled automatically by Supabase client
 * 5. All write operations MUST use this hook to get token
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'

export type AuthState = {
  /** Current user object from Supabase */
  user: User | null
  /** User ID shorthand */
  userId: string | null
  /** User email */
  email: string | null
  /** Current access token for API requests */
  accessToken: string | null
  /** Whether auth state has been checked (initial load complete) */
  initialized: boolean
  /** Whether user is currently authenticated */
  isAuthenticated: boolean
  /** Connected wallet address (from user_metadata or profile) */
  walletAddress: string | null
  /** Whether the user logged in via wallet (SIWE) */
  isWalletUser: boolean
}

export type AuthActions = {
  /**
   * Guard function: returns token if authenticated, otherwise shows login prompt.
   * Use before any write operation.
   * Returns null if not authenticated (caller should abort the operation).
   */
  requireAuth: () => string | null
  /**
   * Get auth headers for fetch requests.
   * Returns empty object if not authenticated.
   */
  getAuthHeaders: () => Record<string, string>
  /** Sign out the user */
  signOut: () => Promise<void>
  /** Refresh session (force token refresh) */
  refreshSession: () => Promise<string | null>
}

export type UnifiedAuth = AuthState & AuthActions

// Module-level state to share across hook instances
let _session: Session | null = null
let _initialized = false
const _listeners = new Set<() => void>()

function notifyListeners() {
  _listeners.forEach(fn => fn())
}

// Initialize auth listener once
let _initPromise: Promise<void> | null = null

function initAuth() {
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      _session = session
      _initialized = true
      notifyListeners()
    } catch (err) {
      console.error('[useUnifiedAuth] Failed to get initial session:', err)
      _initialized = true
      notifyListeners()
    }

    // Listen for auth changes
    supabase.auth.onAuthStateChange((_event, session) => {
      _session = session
      _initialized = true
      notifyListeners()
    })
  })()

  return _initPromise
}

/**
 * Unified authentication hook.
 * Use this as the ONLY source of auth state in client components.
 *
 * @param options.onUnauthenticated - Callback when requireAuth() is called without auth.
 *   Defaults to console.warn. Override to show toast/redirect to login.
 */
export function useUnifiedAuth(options?: {
  onUnauthenticated?: () => void
}): UnifiedAuth {
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    initAuth()

    const listener = () => forceUpdate(n => n + 1)
    _listeners.add(listener)
    return () => { _listeners.delete(listener) }
  }, [])

  const user = _session?.user ?? null
  const userId = user?.id ?? null
  const email = user?.email ?? null
  const accessToken = _session?.access_token ?? null
  const initialized = _initialized
  const isAuthenticated = !!user && !!accessToken
  const walletAddress = (user?.user_metadata?.wallet_address as string) ?? null
  const isWalletUser = !!walletAddress || (email?.endsWith('@wallet.arena') ?? false)

  const requireAuth = useCallback((): string | null => {
    if (!isAuthenticated || !accessToken) {
      if (options?.onUnauthenticated) {
        options.onUnauthenticated()
      }
      return null
    }
    return accessToken
  }, [isAuthenticated, accessToken, options])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!accessToken) return {}
    return { 'Authorization': `Bearer ${accessToken}` }
  }, [accessToken])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    _session = null
    notifyListeners()
  }, [])

  const refreshSession = useCallback(async (): Promise<string | null> => {
    try {
      const { data: { session }, error } = await supabase.auth.refreshSession()
      if (error) {
        console.error('[useUnifiedAuth] Failed to refresh session:', error)
        return null
      }
      _session = session
      notifyListeners()
      return session?.access_token ?? null
    } catch (err) {
      console.error('[useUnifiedAuth] refreshSession error:', err)
      return null
    }
  }, [])

  return useMemo(() => ({
    user,
    userId,
    email,
    accessToken,
    initialized,
    isAuthenticated,
    walletAddress,
    isWalletUser,
    requireAuth,
    getAuthHeaders,
    signOut,
    refreshSession,
  }), [user, userId, email, accessToken, initialized, isAuthenticated, walletAddress, isWalletUser, requireAuth, getAuthHeaders, signOut, refreshSession])
}
