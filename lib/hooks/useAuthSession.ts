'use client'

/**
 * Unified Auth Session Hook - Single Source of Truth
 *
 * Principles:
 * 1. Only ONE source of auth truth - this hook
 * 2. Provides user ID, email, access token, and loading state
 * 3. Automatically refreshes expired sessions
 * 4. Subscribes to auth state changes
 * 5. All write operations MUST check requireAuth() before sending
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'

export type AuthState = {
  userId: string | null
  email: string | null
  accessToken: string | null
  loading: boolean
  /** True once the initial auth check has completed (even if user is null) */
  checked: boolean
}

export type AuthActions = {
  /** Get current valid token - refreshes if expired */
  getToken: () => Promise<string | null>
  /** Returns headers object with Authorization + CSRF */
  getAuthHeaders: () => Promise<Record<string, string>>
  /** Check if user is authenticated - shows toast if not */
  requireAuth: (showToast?: (msg: string, type: string) => void) => boolean
  /** Sign out */
  signOut: () => Promise<void>
}

export type UseAuthSessionReturn = AuthState & AuthActions

/**
 * Unified auth session hook.
 *
 * Usage:
 * ```
 * const { userId, accessToken, loading, checked, requireAuth, getAuthHeaders } = useAuthSession()
 * ```
 */
export function useAuthSession(): UseAuthSessionReturn {
  const [state, setState] = useState<AuthState>({
    userId: null,
    email: null,
    accessToken: null,
    loading: true,
    checked: false,
  })
  const refreshingRef = useRef(false)

  // Initial auth check
  useEffect(() => {
    let cancelled = false

    const initAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled) return

        if (session) {
          setState({
            userId: session.user.id,
            email: session.user.email ?? null,
            accessToken: session.access_token,
            loading: false,
            checked: true,
          })
        } else {
          setState({
            userId: null,
            email: null,
            accessToken: null,
            loading: false,
            checked: true,
          })
        }
      } catch {
        if (!cancelled) {
          setState(prev => ({ ...prev, loading: false, checked: true }))
        }
      }
    }

    initAuth()

    // Subscribe to auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return
      setState({
        userId: session?.user?.id ?? null,
        email: session?.user?.email ?? null,
        accessToken: session?.access_token ?? null,
        loading: false,
        checked: true,
      })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  // Get a fresh token, refreshing if needed
  const getToken = useCallback(async (): Promise<string | null> => {
    // Prevent concurrent refresh attempts
    if (refreshingRef.current) {
      // Wait a bit and return current token
      await new Promise(resolve => setTimeout(resolve, 100))
      return state.accessToken
    }

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        // Check if token is close to expiry (within 60s)
        const expiresAt = session.expires_at
        const now = Math.floor(Date.now() / 1000)
        if (expiresAt && (expiresAt - now) < 60) {
          // Token about to expire, refresh
          refreshingRef.current = true
          try {
            const { data: { session: refreshed } } = await supabase.auth.refreshSession()
            if (refreshed) {
              setState(prev => ({
                ...prev,
                accessToken: refreshed.access_token,
                userId: refreshed.user.id,
                email: refreshed.user.email ?? null,
              }))
              return refreshed.access_token
            }
          } finally {
            refreshingRef.current = false
          }
        }
        return session.access_token
      }
      return null
    } catch {
      return null
    }
  }, [state.accessToken])

  // Get auth headers for API calls
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken()
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    // CSRF headers are added by getCsrfHeaders() separately
    return headers
  }, [getToken])

  // Client-side auth check - returns false if not authenticated
  const requireAuth = useCallback((showToast?: (msg: string, type: string) => void): boolean => {
    if (!state.accessToken || !state.userId) {
      if (showToast) {
        showToast('请先登录', 'warning')
      }
      return false
    }
    return true
  }, [state.accessToken, state.userId])

  // Sign out
  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setState({
      userId: null,
      email: null,
      accessToken: null,
      loading: false,
      checked: true,
    })
  }, [])

  return {
    ...state,
    getToken,
    getAuthHeaders,
    requireAuth,
    signOut,
  }
}
