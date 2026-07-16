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
  commitViewerTransition,
  getViewerScope,
  isViewerTransitionCurrent,
  isViewerScopeCurrent,
  type ViewerScope,
} from '@/lib/auth/viewer-scope'
import { AuthError, type Session } from '@supabase/supabase-js'
import { bearerToken, jwtSubject } from '@/lib/auth/token-subject'
import {
  beginAuthIdentityOperation,
  bindAuthOperationPrincipal,
  captureAuthOperation,
  clearAuthStorage,
  completeAuthIdentityOperation,
  getStoredAuthSession,
  isAuthOperationCurrent,
  rebindAuthOperationPrincipal,
  withAuthSessionWriter,
  type AuthOperationLease,
} from '@/lib/auth/session-operation'

type LazySupabaseClient = Awaited<typeof import('@/lib/supabase/client')>['supabase']
type AuthClient = LazySupabaseClient['auth']
export type PasswordSignInCredentials = Parameters<AuthClient['signInWithPassword']>[0]
export type VerifyOtpCredentials = Parameters<AuthClient['verifyOtp']>[0]
export type UpdateUserAttributes = Parameters<AuthClient['updateUser']>[0]
type PasswordSignInResult = Awaited<ReturnType<AuthClient['signInWithPassword']>>
type VerifyOtpResult = Awaited<ReturnType<AuthClient['verifyOtp']>>
type UpdateUserResult = Awaited<ReturnType<AuthClient['updateUser']>>
export type UpdateUserWithSessionResult = {
  data: {
    user: UpdateUserResult['data']['user']
    session: Session | null
  }
  error: UpdateUserResult['error']
}

class SupersededAuthOperationError extends Error {
  constructor() {
    super('Authentication operation was superseded')
    this.name = 'SupersededAuthOperationError'
  }
}

function supersededAuthError(): AuthError {
  return new AuthError('Authentication operation was superseded', 409, 'auth_operation_superseded')
}
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

function setAnonymousAuthState() {
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
  tokenRefreshCoordinator.observeSession(null)
}

function clearAuthState() {
  setAnonymousAuthState()
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
  tokenRefreshCoordinator.observeSession(session)
}

function broadcastLogout(operation: AuthOperationLease): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  try {
    const channel = new BroadcastChannel('ranking-arena:auth-state')
    channel.postMessage({
      type: 'USER_LOGGED_OUT',
      payload: { userId: null, handle: null, operationId: operation.id },
      timestamp: Date.now(),
      sourceTabId: `signout-${Date.now()}`,
    })
    channel.close()
  } catch {
    // Storage removal remains the cross-tab fallback.
  }
}

function stalePasswordResult(): PasswordSignInResult {
  return {
    data: { user: null, session: null },
    error: supersededAuthError(),
  } as PasswordSignInResult
}

function staleVerifyOtpResult(): VerifyOtpResult {
  return {
    data: { user: null, session: null },
    error: supersededAuthError(),
  } as VerifyOtpResult
}

function staleUpdateUserWithSessionResult(): UpdateUserWithSessionResult {
  return {
    data: { user: null, session: null },
    error: supersededAuthError(),
  }
}

/**
 * Core coordinator: ensures only ONE refresh is in-flight at a time.
 * All concurrent callers receive the same promise result.
 */
class TokenRefreshCoordinator {
  private _inflightRefresh = new Map<string, Promise<string | null>>()
  private _transitionSetter: ((expectedUserId?: string | null) => number) | null = null
  private _transitionOperations = new Map<number, AuthOperationLease>()
  private _sessionWriterTail: Promise<void> = Promise.resolve()
  private _scheduledRefresh: ReturnType<typeof setTimeout> | null = null
  private _resumeListenersInstalled = false

  private refreshOnResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const scope = getViewerScope()
    if (!scope.userId) return
    void this.getValidToken({
      expectedUserId: scope.userId,
      sessionGeneration: scope.sessionGeneration,
    })
  }

  /**
   * Supabase's timer is disabled because it writes the shared session outside
   * our principal lease. Preserve proactive refresh with a timer that re-enters
   * this coordinator, and re-check on tab resume in case browser throttling
   * delayed the timer while the page was hidden.
   */
  observeSession(session: Session | null): void {
    if (this._scheduledRefresh) {
      clearTimeout(this._scheduledRefresh)
      this._scheduledRefresh = null
    }
    if (!session?.expires_at || typeof window === 'undefined') return

    const scope = getViewerScope()
    if (scope.userId !== session.user.id || !isViewerScopeCurrent(scope)) return

    if (!this._resumeListenersInstalled) {
      this._resumeListenersInstalled = true
      window.addEventListener('focus', this.refreshOnResume)
      document.addEventListener('visibilitychange', this.refreshOnResume)
      window.addEventListener('online', this.refreshOnResume)
    }

    // Refresh just inside the coordinator's existing 60-second expiry window.
    // A one-second floor avoids a tight loop if a provider returns a token with
    // an unchanged or already-near expiry timestamp.
    const delay = Math.max(1_000, session.expires_at * 1_000 - Date.now() - 61_000)
    this._scheduledRefresh = setTimeout(() => {
      this._scheduledRefresh = null
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!isViewerScopeCurrent(scope)) return
      void this.forceRefresh({
        expectedUserId: scope.userId,
        sessionGeneration: scope.sessionGeneration,
      })
    }, delay)
  }

  registerIdentityTransitionSetter(setter: (expectedUserId?: string | null) => number): void {
    this._transitionSetter = setter
  }

  beginIdentityTransition(expectedUserId?: string | null): number {
    const operation = beginAuthIdentityOperation(expectedUserId)
    const generation =
      this._transitionSetter?.(expectedUserId) ?? beginViewerTransition(expectedUserId)
    this._transitionOperations.clear()
    this._transitionOperations.set(generation, operation)
    return generation
  }

  completeIdentityTransition(generation: number, userId: string | null): boolean {
    const operation = this._transitionOperations.get(generation)
    this._transitionOperations.delete(generation)
    if (operation && !isAuthOperationCurrent(operation)) return false
    const committed = commitViewerTransition(generation, userId) !== null
    if (committed && operation) completeAuthIdentityOperation(operation, userId)
    return committed
  }

  private transitionOperation(generation: number): AuthOperationLease | null {
    return this._transitionOperations.get(generation) ?? null
  }

  private async runSessionWriter<T>(
    operation: AuthOperationLease,
    writer: (client: LazySupabaseClient) => Promise<T>
  ): Promise<T> {
    const client = await getSupabase()
    const previous = this._sessionWriterTail
    let release!: () => void
    this._sessionWriterTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      if (!isAuthOperationCurrent(operation)) throw new SupersededAuthOperationError()
      return await withAuthSessionWriter(operation, () => writer(client))
    } finally {
      release()
    }
  }

  async settleInflightRefreshes(timeoutMs?: number): Promise<boolean> {
    const requests = [...this._inflightRefresh.values()]
    if (requests.length === 0) return true

    const settlement = Promise.allSettled(requests).then(() => true)
    if (timeoutMs === undefined) return settlement

    return Promise.race([
      settlement,
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs)
        settlement.finally(() => clearTimeout(timer)).catch(() => {})
      }),
    ])
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
    const operation = captureAuthOperation(scope.userId as string)
    if (!operation) return null
    try {
      const sb = await getSupabase()
      const {
        data: { session },
      } = await sb.auth.getSession()

      if (
        !session?.access_token ||
        session.user.id !== scope.userId ||
        !isViewerScopeCurrent(scope) ||
        !isAuthOperationCurrent(operation)
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
    const operation = captureAuthOperation(scope.userId as string)
    if (!operation) return null
    const key = `${scope.viewerKey}:${scope.sessionGeneration}:${operation.id}`
    const existing = this._inflightRefresh.get(key)
    if (existing) return existing

    const request = this._doRefresh(scope, operation)
    this._inflightRefresh.set(key, request)

    try {
      return await request
    } finally {
      if (this._inflightRefresh.get(key) === request) this._inflightRefresh.delete(key)
    }
  }

  private async _doRefresh(
    scope: ViewerScope,
    operation: AuthOperationLease
  ): Promise<string | null> {
    try {
      const {
        data: { session },
        error,
      } = await this.runSessionWriter(operation, (client) => client.auth.refreshSession())

      if (error || !session) {
        logger.warn('[TokenRefresh] Refresh failed:', error?.message ?? 'no session')
        if (isViewerScopeCurrent(scope) && isAuthOperationCurrent(operation)) {
          this.invalidateSession(true)
        }
        return null
      }

      if (
        session.user.id !== scope.userId ||
        !isViewerScopeCurrent(scope) ||
        !isAuthOperationCurrent(operation)
      ) {
        return null
      }

      // Update global auth state so all subscribers (useAuthSession, etc.) see the new token
      updateAuthState(session)
      return session.access_token
    } catch (err) {
      if (err instanceof SupersededAuthOperationError) return null
      logger.warn('[TokenRefresh] Refresh threw:', err)
      if (isViewerScopeCurrent(scope) && isAuthOperationCurrent(operation)) {
        this.invalidateSession(true)
      }
      return null
    }
  }

  private invalidateSession(notifyLost: boolean): void {
    const transitionGeneration = this.beginIdentityTransition(null)
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return
    clearAuthStorage(operation)
    if (!this.completeIdentityTransition(transitionGeneration, null)) return
    if (notifyLost) clearAuthState()
    else setAnonymousAuthState()
    broadcastLogout(operation)
  }

  private finalizeIdentitySession(
    transitionGeneration: number,
    operation: AuthOperationLease,
    session: Session,
    expectedUserId?: string
  ): boolean {
    if (
      !isAuthOperationCurrent(operation) ||
      (expectedUserId !== undefined && session.user.id !== expectedUserId) ||
      !bindAuthOperationPrincipal(operation, session.user.id) ||
      !this.completeIdentityTransition(transitionGeneration, session.user.id)
    ) {
      return false
    }
    updateAuthState(session)
    return true
  }

  private async restoreIdentityTransition(
    transitionGeneration: number,
    operation: AuthOperationLease
  ): Promise<void> {
    if (!isAuthOperationCurrent(operation) || !isViewerTransitionCurrent(transitionGeneration)) {
      return
    }

    try {
      const client = await getSupabase()
      const { data } = await client.auth.getSession()
      if (!isAuthOperationCurrent(operation) || !isViewerTransitionCurrent(transitionGeneration)) {
        return
      }
      const userId = data.session?.user.id ?? null
      if (!rebindAuthOperationPrincipal(operation, userId)) return
      if (!this.completeIdentityTransition(transitionGeneration, userId)) return
      if (data.session) updateAuthState(data.session)
      else setAnonymousAuthState()
    } catch {
      if (
        rebindAuthOperationPrincipal(operation, null) &&
        this.completeIdentityTransition(transitionGeneration, null)
      ) {
        setAnonymousAuthState()
      }
    }
  }

  async signInWithPassword(credentials: PasswordSignInCredentials): Promise<PasswordSignInResult> {
    const transitionGeneration = this.beginIdentityTransition()
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return stalePasswordResult()

    let result: PasswordSignInResult
    try {
      result = await this.runSessionWriter(operation, (client) =>
        client.auth.signInWithPassword(credentials)
      )
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] Password sign-in failed:', error)
      }
      await this.restoreIdentityTransition(transitionGeneration, operation)
      return stalePasswordResult()
    }

    if (result.error || !result.data.session) {
      await this.restoreIdentityTransition(transitionGeneration, operation)
      return result
    }
    return this.finalizeIdentitySession(transitionGeneration, operation, result.data.session)
      ? result
      : stalePasswordResult()
  }

  async reauthenticateWithPassword(
    credentials: PasswordSignInCredentials,
    scope: RefreshScope
  ): Promise<PasswordSignInResult> {
    const viewer = this.captureScope(scope)
    if (!viewer?.userId) return stalePasswordResult()
    const operation = captureAuthOperation(viewer.userId)
    if (!operation) return stalePasswordResult()

    try {
      const result = await this.runSessionWriter(operation, (client) =>
        client.auth.signInWithPassword(credentials)
      )
      if (
        result.error ||
        !result.data.session ||
        result.data.session.user.id !== viewer.userId ||
        !isViewerScopeCurrent(viewer) ||
        !isAuthOperationCurrent(operation)
      ) {
        return result.error ? result : stalePasswordResult()
      }
      updateAuthState(result.data.session)
      return result
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] Password reauthentication failed:', error)
      }
      return stalePasswordResult()
    }
  }

  async verifyOtp(
    credentials: VerifyOtpCredentials,
    expectedUserId?: string
  ): Promise<VerifyOtpResult> {
    const transitionGeneration = this.beginIdentityTransition(expectedUserId)
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return staleVerifyOtpResult()

    let result: VerifyOtpResult
    try {
      result = await this.runSessionWriter(operation, (client) =>
        client.auth.verifyOtp(credentials)
      )
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] OTP verification failed:', error)
      }
      await this.restoreIdentityTransition(transitionGeneration, operation)
      return staleVerifyOtpResult()
    }

    if (result.error || !result.data.session) {
      await this.restoreIdentityTransition(transitionGeneration, operation)
      return result
    }
    return this.finalizeIdentitySession(
      transitionGeneration,
      operation,
      result.data.session,
      expectedUserId
    )
      ? result
      : staleVerifyOtpResult()
  }

  async updateUser(
    attributes: UpdateUserAttributes,
    scope?: RefreshScope
  ): Promise<UpdateUserResult> {
    const result = await this.updateUserWithSession(attributes, scope)
    return {
      data: { user: result.data.user },
      error: result.error,
    } as UpdateUserResult
  }

  /**
   * Update auth attributes and return the exact canonical session owned by the
   * coordinator lease. Login completion must not issue a later singleton
   * getSession call that could silently adopt another account or token.
   */
  async updateUserWithSession(
    attributes: UpdateUserAttributes,
    scope?: RefreshScope
  ): Promise<UpdateUserWithSessionResult> {
    const viewer = this.captureScope(scope)
    if (!viewer?.userId) return staleUpdateUserWithSessionResult()
    const operation = captureAuthOperation(viewer.userId)
    if (!operation) return staleUpdateUserWithSessionResult()

    try {
      const result = await this.runSessionWriter(operation, (client) =>
        client.auth.updateUser(attributes)
      )
      if (result.error) {
        return { data: { user: result.data.user, session: null }, error: result.error }
      }
      if (!isViewerScopeCurrent(viewer) || !isAuthOperationCurrent(operation)) {
        return staleUpdateUserWithSessionResult()
      }
      const session = getStoredAuthSession() as Session | null
      if (
        !session ||
        typeof session.access_token !== 'string' ||
        typeof session.refresh_token !== 'string' ||
        session.user.id !== viewer.userId ||
        !isViewerScopeCurrent(viewer) ||
        !isAuthOperationCurrent(operation)
      ) {
        return staleUpdateUserWithSessionResult()
      }
      updateAuthState(session)
      return { data: { user: result.data.user, session }, error: null }
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] User update failed:', error)
      }
      return staleUpdateUserWithSessionResult()
    }
  }

  /**
   * Account changes share the same identity transition gate as refresh/logout.
   * A stale refresh can finish, but its principal-bound result can no longer be
   * committed once this transition begins.
   */
  async switchSession(refreshToken: string, expectedUserId: string): Promise<Session | null> {
    const transitionGeneration = this.beginIdentityTransition(expectedUserId)
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return null
    let switchedSession: Session | null = null
    try {
      const { data, error } = await this.runSessionWriter(operation, (client) =>
        client.auth.refreshSession({ refresh_token: refreshToken })
      )
      if (error || !data.session || data.session.user.id !== expectedUserId) return null

      if (
        !this.finalizeIdentitySession(transitionGeneration, operation, data.session, expectedUserId)
      ) {
        return null
      }
      switchedSession = data.session
      return switchedSession
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] Account switch failed:', error)
      }
      return null
    } finally {
      if (!switchedSession) {
        await this.restoreIdentityTransition(transitionGeneration, operation)
      }
    }
  }

  /** Establish a server-issued session without exposing a pending login to stale refresh work. */
  async establishSession(
    credentials: { access_token: string; refresh_token: string },
    expectedUserId: string
  ): Promise<Session | null> {
    const transitionGeneration = this.beginIdentityTransition(expectedUserId)
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return null
    let establishedSession: Session | null = null
    try {
      const { data, error } = await this.runSessionWriter(operation, (client) =>
        client.auth.setSession(credentials)
      )
      if (error || !data.session || data.session.user.id !== expectedUserId) return null

      if (
        !this.finalizeIdentitySession(transitionGeneration, operation, data.session, expectedUserId)
      ) {
        return null
      }
      establishedSession = data.session
      return establishedSession
    } catch (error) {
      if (!(error instanceof SupersededAuthOperationError)) {
        logger.warn('[TokenRefresh] Session establishment failed:', error)
      }
      return null
    } finally {
      if (!establishedSession) {
        await this.restoreIdentityTransition(transitionGeneration, operation)
      }
    }
  }

  /**
   * Local logout never waits behind GoTrue's storage lock. The lease is
   * invalidated and browser storage is cleared synchronously; revocation and a
   * best-effort Supabase SIGNED_OUT notification continue in the background.
   */
  async signOut(): Promise<void> {
    const storedSession = getStoredAuthSession()
    const accessToken =
      typeof storedSession?.access_token === 'string' ? storedSession.access_token : null
    const transitionGeneration = this.beginIdentityTransition(null)
    const operation = this.transitionOperation(transitionGeneration)
    if (!operation) return

    clearAuthStorage(operation)
    if (!this.completeIdentityTransition(transitionGeneration, null)) return
    setAnonymousAuthState()
    broadcastLogout(operation)

    // This call is deliberately not awaited. It may sit behind a stale GoTrue
    // lock, but it can no longer delay logout or restore the invalidated lease.
    void this.runSessionWriter(operation, (client) =>
      client.auth.signOut({ scope: 'local' })
    ).catch(() => logger.warn('[TokenRefresh] Deferred local sign-out notification failed'))

    if (accessToken) {
      void getSupabase()
        .then((client) => client.auth.admin.signOut(accessToken, 'local'))
        .catch((error) => logger.warn('[TokenRefresh] Server session revocation failed:', error))
    }
  }

  /**
   * Roll back an authentication attempt only while the browser still owns the
   * exact principal produced by that attempt. This prevents a late failure for
   * A from signing out B after a rapid account switch.
   */
  async signOutIfCurrent(expectedUserId: string, expectedAccessToken?: string): Promise<boolean> {
    if (!expectedUserId) return false

    const storedSession = getStoredAuthSession()
    const accessToken =
      typeof storedSession?.access_token === 'string' ? storedSession.access_token : null
    const viewer = getViewerScope()
    const viewerOwnsExpectedPrincipal =
      isViewerScopeCurrent(viewer) &&
      (viewer.userId === expectedUserId ||
        (viewer.userId === null && (viewer.viewerKey === 'pending' || viewer.viewerKey === 'anon')))

    if (
      !storedSession ||
      storedSession.user?.id !== expectedUserId ||
      !accessToken ||
      jwtSubject(accessToken) !== expectedUserId ||
      (expectedAccessToken !== undefined && accessToken !== expectedAccessToken) ||
      !viewerOwnsExpectedPrincipal
    ) {
      return false
    }

    await this.signOut()
    return true
  }
}

export type RefreshScope = {
  expectedUserId: string | null
  sessionGeneration: number
}

function viewerScopeFromRefreshScope(scope: RefreshScope): ViewerScope {
  return {
    viewerKey: scope.expectedUserId ? `user:${scope.expectedUserId}` : 'anon',
    sessionGeneration: scope.sessionGeneration,
    userId: scope.expectedUserId,
  }
}

function staleAuthResponse(): Response {
  return new Response(JSON.stringify({ error: 'stale_auth_scope' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'x-arena-stale-auth': '1',
    },
  })
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
  scope?: RefreshScope
): Promise<Response> {
  const inputHeaders =
    typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined
  const headers = new Headers(init?.headers ?? inputHeaders)
  const authorizationToken = bearerToken(headers.get('Authorization'))
  const hadAuth = authorizationToken !== null
  const tokenUserId = jwtSubject(authorizationToken)
  const current = getViewerScope()

  // JWT credentials are self-identifying and must agree with any explicit
  // caller scope. Opaque credentials cannot be attributed safely, so callers
  // must bind them to an explicit principal + generation.
  if (
    hadAuth &&
    ((!scope && !tokenUserId) ||
      (scope && (!scope.expectedUserId || (tokenUserId && tokenUserId !== scope.expectedUserId))))
  ) {
    return staleAuthResponse()
  }

  const refreshScope: RefreshScope = scope ?? {
    expectedUserId: tokenUserId,
    sessionGeneration: current.sessionGeneration,
  }
  const capturedScope = viewerScopeFromRefreshScope(refreshScope)

  // Never send credentials captured for an identity that is already stale.
  if (hadAuth && !isViewerScopeCurrent(capturedScope)) return staleAuthResponse()

  const response = await fetch(input, init)

  // A successful A response is still unsafe to apply after A -> B/logout.
  if (hadAuth && !isViewerScopeCurrent(capturedScope)) return staleAuthResponse()

  // If not a 401, return as-is
  if (response.status !== 401) {
    return response
  }

  // Check if the request had an auth header — only refresh if it was an authed request
  if (!hadAuth) {
    return response // Not an authed request, don't try to refresh
  }

  // Try to refresh the token
  const newToken = await tokenRefreshCoordinator.forceRefresh(refreshScope)
  if (!newToken) {
    // Refresh failed — return the original 401 response
    return response
  }

  // The refresh may resolve in the same microtask in which an account switch
  // begins. Validate again immediately before issuing the retry.
  if (!isViewerScopeCurrent(capturedScope)) return staleAuthResponse()

  // Retry with the new token
  const retryHeaders = new Headers(init?.headers)
  retryHeaders.set('Authorization', `Bearer ${newToken}`)
  const retryResponse = await fetch(input, { ...init, headers: retryHeaders })
  // Check once more after the retry completes, before any caller can parse or
  // apply its body to the new viewer.
  return isViewerScopeCurrent(capturedScope) ? retryResponse : staleAuthResponse()
}
