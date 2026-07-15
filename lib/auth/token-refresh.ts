/**
 * Centralized Token Refresh Coordinator
 *
 * Provides a singleton refresh mechanism that:
 * 1. Coalesces concurrent refresh requests (thundering herd prevention)
 * 2. Queues waiting callers behind an in-flight refresh
 * 3. Returns the fresh token to ALL waiters once refresh completes
 * 4. Clears global auth state on unrecoverable refresh failure
 *
 * Inspired by better-auth and Lucia auth token refresh patterns.
 *
 * Usage:
 *   const token = await tokenRefreshCoordinator.getValidToken()
 *   // or after a 401:
 *   const newToken = await tokenRefreshCoordinator.forceRefresh()
 */

import { logger } from '@/lib/logger'
import {
  beginViewerTransition,
  finishViewerTransition,
  getViewerScope,
  isViewerScopeCurrent,
  synchronizeViewerScope,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import type { Session } from '@supabase/supabase-js'

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

// Auth state broadcaster — useAuthSession subscribes to this
type AuthStateSetter = (state: {
  user: import('@supabase/supabase-js').User | null
  userId: string | null
  email: string | null
  accessToken: string | null
  isLoggedIn: boolean
  loading: boolean
  authChecked: boolean
}) => void

let _authStateSetter: AuthStateSetter | null = null

/**
 * Register the global auth state setter from useAuthSession.
 * Called once during initialization.
 */
export function registerAuthStateSetter(setter: AuthStateSetter) {
  _authStateSetter = setter
}

function clearAuthState() {
  if (_authStateSetter) {
    _authStateSetter({
      user: null,
      userId: null,
      email: null,
      accessToken: null,
      isLoggedIn: false,
      loading: false,
      authChecked: true,
    })
  }
  // Notify UI layer that auth was lost due to token refresh failure.
  // React hooks (useAuthSession) listen for this event and show a toast.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('arena:auth-lost', { detail: { reason: 'token_refresh_failed' } })
    )
  }
}

function updateAuthState(session: import('@supabase/supabase-js').Session) {
  if (_authStateSetter) {
    _authStateSetter({
      user: session.user,
      userId: session.user.id,
      email: session.user.email ?? null,
      accessToken: session.access_token,
      isLoggedIn: true,
      loading: false,
      authChecked: true,
    })
  }
}

/**
 * Core coordinator: ensures only ONE refresh is in-flight at a time.
 * All concurrent callers receive the same promise result.
 */
class TokenRefreshCoordinator {
  private _inflightRefresh = new Map<string, Promise<string | null>>()
  private _transitionSetter: ((expectedUserId: string | null) => number) | null = null

  registerIdentityTransitionSetter(setter: (expectedUserId: string | null) => number): void {
    this._transitionSetter = setter
  }

  beginIdentityTransition(expectedUserId: string | null): number {
    return this._transitionSetter?.(expectedUserId) ?? beginViewerTransition(expectedUserId)
  }

  completeIdentityTransition(generation: number): void {
    finishViewerTransition(generation)
  }

  async settleInflightRefreshes(): Promise<void> {
    const requests = [...this._inflightRefresh.values()]
    if (requests.length > 0) await Promise.allSettled(requests)
  }

  private captureScope(options?: RefreshScope): ViewerScope | null {
    const current = getViewerScope()
    const expectedUserId = options?.expectedUserId ?? current.userId
    const sessionGeneration = options?.sessionGeneration ?? current.sessionGeneration
    const scope: ViewerScope = {
      viewerKey: expectedUserId ? `user:${expectedUserId}` : current.viewerKey,
      sessionGeneration,
      userId: expectedUserId,
    }
    return expectedUserId && isViewerScopeCurrent(scope) ? scope : null
  }

  /**
   * Get a valid access token.
   * If the current token is about to expire (within 60s), proactively refresh.
   * Returns null if not authenticated.
   */
  async getValidToken(options?: RefreshScope): Promise<string | null> {
    const scope = this.captureScope(options)
    if (!scope) return null
    try {
      const sb = await getSupabase()
      const {
        data: { session },
      } = await sb.auth.getSession()

      if (
        !session?.access_token ||
        session.user.id !== scope.userId ||
        !isViewerScopeCurrent(scope)
      ) {
        return null
      }

      // Check if token is close to expiry (within 60s)
      const expiresAt = session.expires_at
      const now = Math.floor(Date.now() / 1000)
      if (expiresAt && expiresAt - now < 60) {
        return this.forceRefresh(options)
      }

      return session.access_token
    } catch (err) {
      logger.warn('[TokenRefresh] Failed to get session:', err)
      return null
    }
  }

  /**
   * Force a token refresh. If a refresh is already in-flight,
   * piggyback on it instead of starting a new one (thundering herd prevention).
   */
  async forceRefresh(options?: RefreshScope): Promise<string | null> {
    const scope = this.captureScope(options)
    if (!scope) return null
    const key = `${scope.viewerKey}:${scope.sessionGeneration}`
    const existing = this._inflightRefresh.get(key)
    if (existing) return existing

    const request = this._doRefresh(scope)
    this._inflightRefresh.set(key, request)

    try {
      return await request
    } finally {
      if (this._inflightRefresh.get(key) === request) this._inflightRefresh.delete(key)
    }
  }

  private async _doRefresh(scope: ViewerScope): Promise<string | null> {
    try {
      const sb = await getSupabase()
      const {
        data: { session },
        error,
      } = await sb.auth.refreshSession()

      if (error || !session) {
        logger.warn('[TokenRefresh] Refresh failed:', error?.message ?? 'no session')
        if (isViewerScopeCurrent(scope)) clearAuthState()
        return null
      }

      if (session.user.id !== scope.userId || !isViewerScopeCurrent(scope)) return null

      // Update global auth state so all subscribers (useAuthSession, etc.) see the new token
      updateAuthState(session)
      return session.access_token
    } catch (err) {
      logger.warn('[TokenRefresh] Refresh threw:', err)
      if (isViewerScopeCurrent(scope)) clearAuthState()
      return null
    }
  }

  /**
   * Account changes share the same identity transition gate as refresh/logout.
   * A stale refresh can finish, but its principal-bound result can no longer be
   * committed once this transition begins.
   */
  async switchSession(refreshToken: string, expectedUserId: string): Promise<Session | null> {
    const transitionGeneration = this.beginIdentityTransition(expectedUserId)
    let switchedSession: Session | null = null
    try {
      // Let any refresh that started for the previous principal finish before
      // touching Supabase's shared session storage. Its UI result is already
      // invalidated by the transition generation above.
      await this.settleInflightRefreshes()
      const sb = await getSupabase()
      const { data, error } = await sb.auth.refreshSession({ refresh_token: refreshToken })
      if (error || !data.session || data.session.user.id !== expectedUserId) return null

      synchronizeViewerScope(true, expectedUserId)
      updateAuthState(data.session)
      switchedSession = data.session
      return switchedSession
    } catch (error) {
      logger.warn('[TokenRefresh] Account switch failed:', error)
      return null
    } finally {
      finishViewerTransition(transitionGeneration)
      if (!switchedSession) {
        // Never leave consumers permanently in `pending` after a failed swap.
        // Supabase normally retains the prior session on an invalid target
        // refresh token; re-read it and publish whichever principal remains.
        try {
          const sb = await getSupabase()
          const { data } = await sb.auth.getSession()
          if (data.session) {
            synchronizeViewerScope(true, data.session.user.id)
            updateAuthState(data.session)
          } else {
            clearAuthState()
          }
        } catch {
          clearAuthState()
        }
      }
    }
  }
}

export type RefreshScope = {
  expectedUserId: string | null
  sessionGeneration: number
}

/** Singleton instance */
export const tokenRefreshCoordinator = new TokenRefreshCoordinator()

/**
 * Fetch wrapper that intercepts 401 responses, refreshes the token,
 * and retries the original request exactly once.
 *
 * Works with any fetch-based code — just replace `fetch(url, opts)` with
 * `fetchWithTokenRefresh(url, opts)`.
 *
 * If the caller already provides an Authorization header, that token is used
 * for the initial request. On 401, the coordinator refreshes and retries.
 */
export async function fetchWithTokenRefresh(
  input: RequestInfo | URL,
  init?: RequestInit,
  scope: RefreshScope = {
    expectedUserId: getViewerScope().userId,
    sessionGeneration: getViewerScope().sessionGeneration,
  }
): Promise<Response> {
  // Make the initial request
  const response = await fetch(input, init)

  // If not a 401, return as-is
  if (response.status !== 401) {
    return response
  }

  // Check if the request had an auth header — only refresh if it was an authed request
  const headers = new Headers(init?.headers)
  const hadAuth = headers.has('Authorization')
  if (!hadAuth) {
    return response // Not an authed request, don't try to refresh
  }

  // Try to refresh the token
  const newToken = await tokenRefreshCoordinator.forceRefresh(scope)
  if (!newToken) {
    // Refresh failed — return the original 401 response
    return response
  }

  // Retry with the new token
  const retryHeaders = new Headers(init?.headers)
  retryHeaders.set('Authorization', `Bearer ${newToken}`)
  return fetch(input, { ...init, headers: retryHeaders })
}
