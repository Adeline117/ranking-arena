'use client'

/**
 * Unified Auth Session Hook
 * Single source of truth for authentication state across the entire app.
 *
 * Principles:
 * 1. One canonical source - no page should independently call supabase.auth
 * 2. Provides userId, email, accessToken, and auth-guard utilities
 * 3. Handles token refresh transparently
 * 4. Distinguishes between "not logged in", "token expired", and "forbidden"
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import type { User, Session } from '@supabase/supabase-js'

export type AuthState = {
  user: User | null
  userId: string | null
  email: string | null
  accessToken: string | null
  isLoggedIn: boolean
  loading: boolean
  /** True once the initial auth check has completed */
  authChecked: boolean
}

export type AuthError = {
  type: 'NOT_AUTHENTICATED' | 'TOKEN_EXPIRED' | 'FORBIDDEN' | 'NETWORK_ERROR'
  message: string
}

export type AuthSessionReturn = AuthState & {
  /** Get headers for authenticated API requests. Returns null if not authenticated. */
  getAuthHeaders: () => Record<string, string> | null
  /** Guard a write operation: returns auth headers or shows login prompt and returns null */
  requireAuth: (options?: { redirectToLogin?: boolean }) => Record<string, string> | null
  /** Refresh the current session token */
  refreshSession: () => Promise<boolean>
  /** Categorize an HTTP error response into an AuthError */
  categorizeError: (status: number, body?: { error?: string }) => AuthError | null
  /** Sign out */
  signOut: () => Promise<void>
}

let globalAuthState: AuthState = {
  user: null,
  userId: null,
  email: null,
  accessToken: null,
  isLoggedIn: false,
  loading: true,
  authChecked: false,
}

// Global listeners for state updates
const listeners = new Set<(state: AuthState) => void>()

function setGlobalAuthState(newState: Partial<AuthState>) {
  globalAuthState = { ...globalAuthState, ...newState }
  listeners.forEach(listener => listener(globalAuthState))
}

// Initialize auth state once
let initialized = false

function initializeAuth() {
  if (initialized) return
  initialized = true

  // Get initial session
  supabase.auth.getSession().then(({ data }) => {
    updateFromSession(data.session)
    setGlobalAuthState({ loading: false, authChecked: true })
  })

  // Subscribe to auth state changes
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      setGlobalAuthState({
        user: null,
        userId: null,
        email: null,
        accessToken: null,
        isLoggedIn: false,
        authChecked: true,
        loading: false,
      })
    } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
      updateFromSession(session)
      setGlobalAuthState({ loading: false, authChecked: true })
    }
  })
}

function updateFromSession(session: Session | null) {
  if (session?.user) {
    setGlobalAuthState({
      user: session.user,
      userId: session.user.id,
      email: session.user.email ?? null,
      accessToken: session.access_token,
      isLoggedIn: true,
    })
  } else {
    setGlobalAuthState({
      user: null,
      userId: null,
      email: null,
      accessToken: null,
      isLoggedIn: false,
    })
  }
}

export function useAuthSession(): AuthSessionReturn {
  const [state, setState] = useState<AuthState>(globalAuthState)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    // Initialize on first use
    initializeAuth()

    // Subscribe to global state changes
    const listener = (newState: AuthState) => {
      setState(newState)
    }
    listeners.add(listener)

    // Sync with current global state
    setState(globalAuthState)

    return () => {
      listeners.delete(listener)
    }
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> | null => {
    const { accessToken } = stateRef.current
    if (!accessToken) return null
    return { 'Authorization': `Bearer ${accessToken}` }
  }, [])

  const requireAuth = useCallback((options?: { redirectToLogin?: boolean }): Record<string, string> | null => {
    const { accessToken, isLoggedIn } = stateRef.current
    if (!isLoggedIn || !accessToken) {
      if (options?.redirectToLogin !== false && typeof window !== 'undefined') {
        // Store current URL for redirect back after login
        const returnUrl = window.location.pathname + window.location.search
        window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`
      }
      return null
    }
    return { 'Authorization': `Bearer ${accessToken}` }
  }, [])

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (error || !data.session) return false
      updateFromSession(data.session)
      setGlobalAuthState({ loading: false, authChecked: true })
      return true
    } catch {
      return false
    }
  }, [])

  const categorizeError = useCallback((status: number, body?: { error?: string }): AuthError | null => {
    if (status === 401) {
      const msg = body?.error?.toLowerCase() ?? ''
      if (msg.includes('expired') || msg.includes('refresh')) {
        return { type: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录' }
      }
      return { type: 'NOT_AUTHENTICATED', message: '请先登录' }
    }
    if (status === 403) {
      return { type: 'FORBIDDEN', message: body?.error || '没有权限执行此操作' }
    }
    return null
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  return useMemo(() => ({
    ...state,
    getAuthHeaders,
    requireAuth,
    refreshSession,
    categorizeError,
    signOut,
  }), [state, getAuthHeaders, requireAuth, refreshSession, categorizeError, signOut])
}

/**
 * Utility: Make an authenticated API request with proper error handling.
 * Handles token refresh on 401, categorizes errors properly.
 */
export async function authFetch(
  url: string,
  options: RequestInit & { requireAuth?: boolean } = {}
): Promise<Response> {
  const { requireAuth: needsAuth = true, ...fetchOptions } = options

  // Get current access token
  const { data: { session } } = await supabase.auth.getSession()

  if (needsAuth && !session?.access_token) {
    throw Object.assign(new Error('Not authenticated'), { authError: { type: 'NOT_AUTHENTICATED' as const, message: '请先登录' } })
  }

  const headers = new Headers(fetchOptions.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }

  const response = await fetch(url, { ...fetchOptions, headers })

  // Handle token expiry: try to refresh and retry once
  if (response.status === 401 && session) {
    const { data: refreshData } = await supabase.auth.refreshSession()
    if (refreshData.session) {
      headers.set('Authorization', `Bearer ${refreshData.session.access_token}`)
      return fetch(url, { ...fetchOptions, headers })
    }
  }

  return response
}
