'use client'

/**
 * Unified Auth Session Hook
 * Single source of truth for authentication state across the entire app.
 *
 * Principles:
 * 1. One canonical source - no page should independently call supabase.auth
 * 2. Provides userId, email, accessToken, and auth-guard utilities
 * 3. Handles token refresh transparently (proactive expiry detection)
 * 4. Distinguishes between "not logged in", "token expired", and "forbidden"
 * 5. All write operations MUST check requireAuth() before sending
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// Lazy-load Supabase client to avoid pulling ~50KB into the initial client bundle.
// The actual import happens on first use (initializeAuth), which is deferred.
type LazySupabaseClient = Awaited<typeof import('@/lib/supabase/client')>['supabase']
let _supabase: LazySupabaseClient | null = null
let _supabasePromise: Promise<LazySupabaseClient> | null = null

function getSupabase(): Promise<LazySupabaseClient> {
  if (_supabase) return Promise.resolve(_supabase)
  if (!_supabasePromise) {
    _supabasePromise = import('@/lib/supabase/client').then(m => {
      _supabase = m.supabase
      return _supabase
    })
  }
  return _supabasePromise
}

// Synchronous getter — only works after lazy init resolves.
// Falls back to null before that (callers must handle).
function _getSupabaseSync() {
  return _supabase
}

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
  /** Get a fresh token, refreshing if close to expiry (within 60s) */
  getToken: () => Promise<string | null>
  /** Get headers for authenticated API requests. Returns null if not authenticated. */
  getAuthHeaders: () => Record<string, string> | null
  /** Get headers asynchronously, refreshing token if needed */
  getAuthHeadersAsync: () => Promise<Record<string, string>>
  /** Guard a write operation: returns auth headers or shows login prompt and returns null */
  requireAuth: (options?: { redirectToLogin?: boolean; showToast?: (msg: string, type: string) => void }) => Record<string, string> | null
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

  // Lazy-load Supabase then initialize auth
  getSupabase().then((sb) => {
    // Get initial session
    sb.auth.getSession().then(({ data }) => {
      updateFromSession(data.session)
      setGlobalAuthState({ loading: false, authChecked: true })
    }).catch((err) => {
      logger.error('[useAuthSession] Failed to get initial session:', err)
      setGlobalAuthState({ loading: false, authChecked: true })
    })

    // Subscribe to auth state changes
    sb.auth.onAuthStateChange((event, session) => {
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
  }).catch((err) => {
    logger.error('[useAuthSession] Failed to load Supabase:', err)
    setGlobalAuthState({ loading: false, authChecked: true })
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
  const refreshingRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

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

  // Get a fresh token, refreshing if close to expiry (within 60s)
  const getToken = useCallback(async (): Promise<string | null> => {
    // Prevent concurrent refresh attempts
    if (refreshingRef.current) {
      await new Promise(resolve => setTimeout(resolve, 100))
      return stateRef.current.accessToken
    }

    try {
      const sb = await getSupabase()
      const { data: { session } } = await sb.auth.getSession()
      if (session?.access_token) {
        // Check if token is close to expiry (within 60s)
        const expiresAt = session.expires_at
        const now = Math.floor(Date.now() / 1000)
        if (expiresAt && (expiresAt - now) < 60) {
          // Token about to expire, refresh
          refreshingRef.current = true
          try {
            const { data: { session: refreshed }, error: refreshError } = await sb.auth.refreshSession()
            if (refreshed) {
              updateFromSession(refreshed)
              setGlobalAuthState({ loading: false, authChecked: true })
              return refreshed.access_token
            }
            // Refresh failed — clear stale auth state so UI prompts re-login
            if (refreshError) {
              logger.warn('[getToken] Token refresh failed:', refreshError.message)
            }
            setGlobalAuthState({
              user: null, userId: null, email: null, accessToken: null,
              isLoggedIn: false, loading: false, authChecked: true,
            })
            return null
          } finally {
            refreshingRef.current = false
          }
        }
        return session.access_token
      }
      return null
    } catch (_err) {
      /* non-critical: session lookup failed */
      return null
    }
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> | null => {
    const { accessToken } = stateRef.current
    if (!accessToken) return null
    return { 'Authorization': `Bearer ${accessToken}` }
  }, [])

  // Async version that refreshes token if needed
  const getAuthHeadersAsync = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken()
    const headers: Record<string, string> = {}
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    return headers
  }, [getToken])

  const requireAuth = useCallback((options?: { redirectToLogin?: boolean; showToast?: (msg: string, type: string) => void }): Record<string, string> | null => {
    const { accessToken, isLoggedIn } = stateRef.current
    if (!isLoggedIn || !accessToken) {
      if (options?.showToast) {
        options.showToast('请先登录', 'warning')
      }
      if (options?.redirectToLogin !== false && typeof window !== 'undefined') {
        // Open login modal instead of redirecting to /login page
        import('@/lib/hooks/useLoginModal').then(({ useLoginModal }) => {
          useLoginModal.getState().openLoginModal()
        }).catch(() => {
          // Fallback to redirect if module unavailable
          const returnUrl = window.location.pathname + window.location.search
          window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`
        })
      }
      return null
    }
    return { 'Authorization': `Bearer ${accessToken}` }
  }, [])

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const sb = await getSupabase()
      const { data, error } = await sb.auth.refreshSession()
      if (error || !data.session) return false
      updateFromSession(data.session)
      setGlobalAuthState({ loading: false, authChecked: true })
      return true
    } catch (_err) {
      /* non-critical: session refresh failed */
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
    const sb = await getSupabase()
    await sb.auth.signOut()
    setGlobalAuthState({
      user: null,
      userId: null,
      email: null,
      accessToken: null,
      isLoggedIn: false,
      loading: false,
      authChecked: true,
    })
  }, [])

  return useMemo(() => ({
    ...state,
    getToken,
    getAuthHeaders,
    getAuthHeadersAsync,
    requireAuth,
    refreshSession,
    categorizeError,
    signOut,
  }), [state, getToken, getAuthHeaders, getAuthHeadersAsync, requireAuth, refreshSession, categorizeError, signOut])
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
  const sb = await getSupabase()
  const { data: { session } } = await sb.auth.getSession()

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
    try {
      const { data: refreshData, error: refreshError } = await sb.auth.refreshSession()
      if (refreshData.session) {
        updateFromSession(refreshData.session)
        headers.set('Authorization', `Bearer ${refreshData.session.access_token}`)
        return fetch(url, { ...fetchOptions, headers })
      }
      // Refresh failed — session is dead, clear auth state so UI updates
      if (refreshError) {
        logger.warn('[authFetch] Token refresh failed, clearing auth state:', refreshError.message)
      }
      setGlobalAuthState({
        user: null, userId: null, email: null, accessToken: null,
        isLoggedIn: false, loading: false, authChecked: true,
      })
    } catch (refreshErr) {
      logger.warn('[authFetch] Token refresh threw, clearing auth state:', refreshErr)
      setGlobalAuthState({
        user: null, userId: null, email: null, accessToken: null,
        isLoggedIn: false, loading: false, authChecked: true,
      })
    }
  }

  return response
}
