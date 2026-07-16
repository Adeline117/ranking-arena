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
import { t } from '@/lib/i18n'
import { tokenRefreshCoordinator, registerAuthStateSetter } from '@/lib/auth/token-refresh'
import {
  beginViewerTransition,
  commitViewerTransition,
  getViewerScope,
  isExpectedTransitionSession,
  isViewerScopeCurrent,
  synchronizeViewerScope,
  type ViewerKey,
} from '@/lib/auth/viewer-scope'

// Lazy-load Supabase client to avoid pulling ~50KB into the initial client bundle.
// The actual import happens on first use (initializeAuth), which is deferred.
type LazySupabaseClient = Awaited<typeof import('@/lib/supabase/client')>['supabase']
let _supabase: LazySupabaseClient | null = null
let _supabasePromise: Promise<LazySupabaseClient> | null = null

function getSupabase(): Promise<LazySupabaseClient> {
  if (_supabase) return Promise.resolve(_supabase)
  if (!_supabasePromise) {
    _supabasePromise = import('@/lib/supabase/client').then((m) => {
      _supabase = m.supabase
      return _supabase
    })
  }
  return _supabasePromise
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
  /** Stable cache identity. Token refreshes for the same user do not change it. */
  viewerKey: ViewerKey
  /** Monotonic principal epoch used to discard work from an older viewer. */
  sessionGeneration: number
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
  requireAuth: (options?: {
    redirectToLogin?: boolean
    showToast?: (msg: string, type: string) => void
  }) => Record<string, string> | null
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
  viewerKey: 'pending',
  sessionGeneration: 0,
}

// Global listeners for state updates
const listeners = new Set<(state: AuthState) => void>()

function setGlobalAuthState(newState: Partial<AuthState>) {
  const next = { ...globalAuthState, ...newState }
  const scope = synchronizeViewerScope(next.authChecked, next.userId)
  globalAuthState = {
    ...next,
    viewerKey: scope.viewerKey,
    sessionGeneration: scope.sessionGeneration,
  }
  listeners.forEach((listener) => listener(globalAuthState))
}

function enterIdentityTransition(expectedUserId: string | null): number {
  const generation = beginViewerTransition(expectedUserId)
  const scope = getViewerScope()
  globalAuthState = {
    ...globalAuthState,
    user: null,
    userId: null,
    email: null,
    accessToken: null,
    isLoggedIn: false,
    loading: true,
    authChecked: false,
    viewerKey: scope.viewerKey,
    sessionGeneration: scope.sessionGeneration,
  }
  listeners.forEach((listener) => listener(globalAuthState))
  return generation
}

// Initialize auth state once
let initialized = false

function initializeAuth() {
  if (initialized) return
  initialized = true
  const initializationScope = getViewerScope()

  // Register setGlobalAuthState with the centralized token refresh coordinator
  // so it can update auth state when tokens are refreshed or sessions expire.
  registerAuthStateSetter((state) => setGlobalAuthState(state))
  tokenRefreshCoordinator.registerIdentityTransitionSetter(enterIdentityTransition)

  // Listen for auth-lost events (fired by token-refresh.ts on unrecoverable refresh failure)
  // and show a toast notification so the user knows they need to log in again.
  if (typeof window !== 'undefined') {
    window.addEventListener('arena:auth-lost', () => {
      // Lazy-import to avoid circular dependency
      Promise.all([import('@/lib/hooks/useApiMutation'), import('@/lib/i18n')])
        .then(([{ getGlobalToast }, { t }]) => {
          const toast = getGlobalToast()
          if (toast) {
            toast(t('sessionExpired'), 'warning')
          }
        })
        .catch(() => {
          logger.warn('[useAuthSession] Could not show auth-lost toast')
        })

      // Open login modal so user can re-authenticate in-place (not just a toast)
      import('@/lib/hooks/useLoginModal')
        .then(({ useLoginModal }) => {
          useLoginModal.getState().openLoginModal('session-expired')
        })
        .catch(() => {})
    })
  }

  // Lazy-load Supabase then initialize auth
  getSupabase()
    .then((sb) => {
      // Get initial session
      const initialScope = getViewerScope()
      sb.auth
        .getSession()
        .then(({ data }) => {
          if (
            getViewerScope().sessionGeneration !== initialScope.sessionGeneration ||
            !isExpectedTransitionSession(data.session?.user.id ?? null)
          ) {
            return
          }
          updateFromSession(data.session)
          setGlobalAuthState({ loading: false, authChecked: true })
        })
        .catch((err) => {
          if (
            getViewerScope().sessionGeneration !== initialScope.sessionGeneration ||
            !isExpectedTransitionSession(null)
          ) {
            return
          }
          logger.error('[useAuthSession] Failed to get initial session:', err)
          setGlobalAuthState({ loading: false, authChecked: true })
        })

      // Listen for cross-tab auth broadcasts via BroadcastChannel.
      // Supabase's storage-event listener can miss events when tabs are inactive.
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        try {
          const authChannel = new BroadcastChannel('ranking-arena:auth-state')
          authChannel.onmessage = (event: MessageEvent) => {
            if (event.data?.type === 'USER_LOGGED_OUT') {
              const transitionGeneration = enterIdentityTransition(null)
              if (commitViewerTransition(transitionGeneration, null)) {
                setGlobalAuthState({
                  user: null,
                  userId: null,
                  email: null,
                  accessToken: null,
                  isLoggedIn: false,
                  authChecked: true,
                  loading: false,
                })
              }
            } else if (event.data?.type === 'TOKEN_REFRESHED') {
              // Another tab refreshed the token — re-read session from shared cookie store
              // so this tab picks up the fresh token without an independent refresh request.
              const scope = getViewerScope()
              sb.auth
                .getSession()
                .then(({ data }) => {
                  if (
                    data.session &&
                    getViewerScope().sessionGeneration === scope.sessionGeneration &&
                    data.session.user.id === scope.userId &&
                    isExpectedTransitionSession(data.session.user.id)
                  ) {
                    updateFromSession(data.session)
                    setGlobalAuthState({ loading: false, authChecked: true })
                  }
                })
                .catch(() => {
                  logger.warn(
                    '[useAuthSession] Failed to re-read session after cross-tab token refresh'
                  )
                })
            }
          }
        } catch {
          /* BroadcastChannel not supported — storage events are fallback */
        }
      }

      // Subscribe to auth state changes
      sb.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
          if (!isExpectedTransitionSession(null)) return
          setGlobalAuthState({
            user: null,
            userId: null,
            email: null,
            accessToken: null,
            isLoggedIn: false,
            authChecked: true,
            loading: false,
          })
        } else if (
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED' ||
          event === 'INITIAL_SESSION'
        ) {
          if (!isExpectedTransitionSession(session?.user.id ?? null)) return
          // A refresh that began for A may finish after a completed A -> B
          // account switch. Supabase emits that result independently of the
          // awaiting coordinator, so reject it at the event boundary too.
          if (event === 'TOKEN_REFRESHED' && session?.user.id !== getViewerScope().userId) {
            return
          }
          updateFromSession(session)
          setGlobalAuthState({ loading: false, authChecked: true })

          // Broadcast token refresh to other tabs so they pick up the fresh session
          if (
            event === 'TOKEN_REFRESHED' &&
            typeof window !== 'undefined' &&
            'BroadcastChannel' in window
          ) {
            try {
              const ch = new BroadcastChannel('ranking-arena:auth-state')
              ch.postMessage({ type: 'TOKEN_REFRESHED', timestamp: Date.now() })
              ch.close()
            } catch {
              /* BroadcastChannel not supported */
            }
          }
        }
      })
    })
    .catch((err) => {
      if (
        getViewerScope().sessionGeneration !== initializationScope.sessionGeneration ||
        !isExpectedTransitionSession(null)
      ) {
        return
      }
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

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    // Initialize on first use
    initializeAuth()

    // Subscribe to global state changes
    const listener = (newState: AuthState) => {
      // Synchronous getters close over stateRef. Update it before scheduling a
      // React render so an identity transition fails closed in the same tick.
      stateRef.current = newState
      setState(newState)
    }
    listeners.add(listener)

    // Sync with current global state
    stateRef.current = globalAuthState
    setState(globalAuthState)

    return () => {
      listeners.delete(listener)
    }
  }, [])

  // Get a fresh token, refreshing if close to expiry (within 60s).
  // Delegates to the centralized TokenRefreshCoordinator which handles
  // thundering herd prevention (concurrent callers share one in-flight refresh).
  const getToken = useCallback(async (): Promise<string | null> => {
    const { userId, sessionGeneration } = stateRef.current
    return tokenRefreshCoordinator.getValidToken({ expectedUserId: userId, sessionGeneration })
  }, [])

  const getAuthHeaders = useCallback((): Record<string, string> | null => {
    const { accessToken } = stateRef.current
    if (!accessToken) return null
    return { Authorization: `Bearer ${accessToken}` }
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

  const requireAuth = useCallback(
    (options?: {
      redirectToLogin?: boolean
      showToast?: (msg: string, type: string) => void
    }): Record<string, string> | null => {
      const { accessToken, isLoggedIn } = stateRef.current
      if (!isLoggedIn || !accessToken) {
        if (options?.showToast) {
          options.showToast(t('pleaseLoginFirst'), 'warning')
        }
        if (options?.redirectToLogin !== false && typeof window !== 'undefined') {
          // Open login modal instead of redirecting to /login page
          import('@/lib/hooks/useLoginModal')
            .then(({ useLoginModal }) => {
              useLoginModal.getState().openLoginModal()
            })
            .catch(() => {
              // Fallback to redirect if module unavailable
              const returnUrl = window.location.pathname + window.location.search
              window.location.href = `/login?returnUrl=${encodeURIComponent(returnUrl)}`
            })
        }
        return null
      }
      return { Authorization: `Bearer ${accessToken}` }
    },
    []
  )

  // Force a token refresh via the centralized coordinator.
  // Returns true if refresh succeeded, false otherwise.
  const refreshSession = useCallback(async (): Promise<boolean> => {
    const { userId, sessionGeneration } = stateRef.current
    const token = await tokenRefreshCoordinator.forceRefresh({
      expectedUserId: userId,
      sessionGeneration,
    })
    return token !== null
  }, [])

  const categorizeError = useCallback(
    (status: number, body?: { error?: string }): AuthError | null => {
      if (status === 401) {
        const msg = body?.error?.toLowerCase() ?? ''
        if (msg.includes('expired') || msg.includes('refresh')) {
          return { type: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录' }
        }
        return { type: 'NOT_AUTHENTICATED', message: t('pleaseLoginFirst') }
      }
      if (status === 403) {
        return { type: 'FORBIDDEN', message: body?.error || '没有权限执行此操作' }
      }
      return null
    },
    []
  )

  const signOut = useCallback(async () => {
    const sb = await getSupabase()
    const transitionGeneration = tokenRefreshCoordinator.beginIdentityTransition(null)
    let refreshesSettled = true
    try {
      refreshesSettled = await tokenRefreshCoordinator.settleInflightRefreshes(3_000)
      await sb.auth.signOut()
    } catch (error) {
      logger.warn('[useAuthSession] Sign out failed:', error)
    }
    if (!tokenRefreshCoordinator.completeIdentityTransition(transitionGeneration, null)) return
    setGlobalAuthState({
      user: null,
      userId: null,
      email: null,
      accessToken: null,
      isLoggedIn: false,
      loading: false,
      authChecked: true,
    })

    // A refresh that outlived the bounded wait may have written its session to
    // Supabase storage after the first signOut. Clear it again, but only if the
    // user has not started another login/switch since this anon epoch began.
    if (!refreshesSettled) {
      const committedAnonScope = getViewerScope()
      void tokenRefreshCoordinator.settleInflightRefreshes().then(async () => {
        if (
          committedAnonScope.viewerKey !== 'anon' ||
          getViewerScope().viewerKey !== committedAnonScope.viewerKey ||
          getViewerScope().sessionGeneration !== committedAnonScope.sessionGeneration
        ) {
          return
        }
        try {
          await sb.auth.signOut()
        } catch {
          logger.warn('[useAuthSession] Could not clear a late refresh after sign out')
        }
      })
    }
    // Explicitly broadcast logout to all other tabs via BroadcastChannel.
    // Supabase's storage-event listener can miss this when tabs are inactive.
    try {
      const channel = new BroadcastChannel('ranking-arena:auth-state')
      channel.postMessage({
        type: 'USER_LOGGED_OUT',
        payload: { userId: null, handle: null },
        timestamp: Date.now(),
        sourceTabId: `signout-${Date.now()}`,
      })
      channel.close()
    } catch {
      /* BroadcastChannel not supported — storage events are fallback */
    }
  }, [])

  return useMemo(
    () => ({
      ...state,
      getToken,
      getAuthHeaders,
      getAuthHeadersAsync,
      requireAuth,
      refreshSession,
      categorizeError,
      signOut,
    }),
    [
      state,
      getToken,
      getAuthHeaders,
      getAuthHeadersAsync,
      requireAuth,
      refreshSession,
      categorizeError,
      signOut,
    ]
  )
}

function staleAuthFetchResponse(): Response {
  return new Response(JSON.stringify({ error: 'stale_auth_scope' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'x-arena-stale-auth': '1',
    },
  })
}

/**
 * Utility: Make an authenticated API request with proper error handling.
 *
 * On 401, delegates to the centralized TokenRefreshCoordinator which:
 * - Coalesces concurrent refresh requests (thundering herd prevention)
 * - Retries the original request with the fresh token
 * - Clears auth state on unrecoverable failure
 */
export async function authFetch(
  url: string,
  options: RequestInit & { requireAuth?: boolean } = {}
): Promise<Response> {
  const { requireAuth: needsAuth = true, ...fetchOptions } = options

  // Get a valid token (proactively refreshes if near expiry)
  const scope = getViewerScope()
  const requestScope = {
    viewerKey: scope.viewerKey,
    sessionGeneration: scope.sessionGeneration,
    userId: scope.userId,
  }
  const browserBound = typeof window !== 'undefined'
  if (browserBound && requestScope.viewerKey === 'pending') return staleAuthFetchResponse()
  const token = await tokenRefreshCoordinator.getValidToken({
    expectedUserId: scope.userId,
    sessionGeneration: scope.sessionGeneration,
  })

  if (browserBound && !isViewerScopeCurrent(requestScope)) return staleAuthFetchResponse()

  if (needsAuth && !token) {
    throw Object.assign(new Error('Not authenticated'), {
      authError: { type: 'NOT_AUTHENTICATED' as const, message: t('pleaseLoginFirst') },
    })
  }

  const headers = new Headers(fetchOptions.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  if (browserBound && !isViewerScopeCurrent(requestScope)) return staleAuthFetchResponse()
  const response = await fetch(url, { ...fetchOptions, headers })
  if (browserBound && !isViewerScopeCurrent(requestScope)) return staleAuthFetchResponse()

  // Handle 401: refresh via coordinator (queues concurrent requests) and retry once
  if (response.status === 401 && token) {
    const newToken = await tokenRefreshCoordinator.forceRefresh({
      expectedUserId: scope.userId,
      sessionGeneration: scope.sessionGeneration,
    })
    if (newToken) {
      if (browserBound && !isViewerScopeCurrent(requestScope)) return staleAuthFetchResponse()
      headers.set('Authorization', `Bearer ${newToken}`)
      const retryResponse = await fetch(url, { ...fetchOptions, headers })
      return browserBound && !isViewerScopeCurrent(requestScope)
        ? staleAuthFetchResponse()
        : retryResponse
    }
    // Refresh failed — coordinator already cleared auth state
  }

  return response
}
