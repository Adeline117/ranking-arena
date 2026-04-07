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
  private _inflightRefresh: Promise<string | null> | null = null

  /**
   * Get a valid access token.
   * If the current token is about to expire (within 60s), proactively refresh.
   * Returns null if not authenticated.
   */
  async getValidToken(): Promise<string | null> {
    try {
      const sb = await getSupabase()
      const { data: { session } } = await sb.auth.getSession()

      if (!session?.access_token) return null

      // Check if token is close to expiry (within 60s)
      const expiresAt = session.expires_at
      const now = Math.floor(Date.now() / 1000)
      if (expiresAt && (expiresAt - now) < 60) {
        return this.forceRefresh()
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
  async forceRefresh(): Promise<string | null> {
    // If a refresh is already happening, wait for it
    if (this._inflightRefresh) {
      return this._inflightRefresh
    }

    // Start a new refresh and store the promise so concurrent callers can share it
    this._inflightRefresh = this._doRefresh()

    try {
      return await this._inflightRefresh
    } finally {
      // Clear the in-flight promise so future calls start fresh
      this._inflightRefresh = null
    }
  }

  private async _doRefresh(): Promise<string | null> {
    try {
      const sb = await getSupabase()
      const { data: { session }, error } = await sb.auth.refreshSession()

      if (error || !session) {
        logger.warn('[TokenRefresh] Refresh failed:', error?.message ?? 'no session')
        clearAuthState()
        return null
      }

      // Update global auth state so all subscribers (useAuthSession, etc.) see the new token
      updateAuthState(session)
      return session.access_token
    } catch (err) {
      logger.warn('[TokenRefresh] Refresh threw:', err)
      clearAuthState()
      return null
    }
  }
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
  const newToken = await tokenRefreshCoordinator.forceRefresh()
  if (!newToken) {
    // Refresh failed — return the original 401 response
    return response
  }

  // Retry with the new token
  const retryHeaders = new Headers(init?.headers)
  retryHeaders.set('Authorization', `Bearer ${newToken}`)
  return fetch(input, { ...init, headers: retryHeaders })
}
