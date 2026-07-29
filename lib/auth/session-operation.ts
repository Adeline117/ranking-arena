/**
 * Cross-tab ownership for browser auth session writes.
 *
 * Supabase password/OTP helpers write localStorage before their promises
 * resolve, and those helpers do not all use GoTrue's storage lock. A component
 * level request CAS therefore cannot stop a late A operation from restoring A
 * after B/login/logout. Every intentional session writer captures this lease,
 * and the storage adapter verifies it again at the actual write boundary.
 */

export const AUTH_STORAGE_KEY = 'arena-auth'
export const AUTH_OPERATION_STORAGE_KEY = 'arena-auth-operation'
export const AUTH_OPERATION_STATE_STORAGE_PREFIX = 'arena-auth-operation-state:'

const AUTH_SESSION_INTENT_STORAGE_PREFIX = 'arena-auth-session-intent:'
const AUTH_SESSION_BASE_STORAGE_PREFIX = 'arena-auth-session-base:'

export type AuthOperationLease = {
  id: string
  expectedUserId: string | null
  targetKnown: boolean
  identityTransition: boolean
}

/**
 * Tab-local proof that this document's redirect parser, rather than a newer
 * cross-tab/session operation, acquired the callback principal.
 */
export type AuthRedirectAcquisitionReceipt = Readonly<{
  operationId: string
  userId: string
  navigationKey: string
  purpose: 'oauth-callback' | 'password-recovery'
}>

type StoredSession = {
  access_token?: unknown
  refresh_token?: unknown
  user?: { id?: unknown }
}

type StoredAuthOperationPointer = AuthOperationLease & {
  /** Unique journal entry containing the canonical value at publication. */
  stableSessionKey: string
}

type StoredStableSession = Readonly<{
  operationId: string
  value: string | null
}>

type AuthSessionIntent = Readonly<{
  operationId: string
  writeId: string
  expectedUserId: string | null
  value: string | null
}>

type PendingPasswordRecoveryRedirect = Readonly<{
  accessToken: string
  refreshToken: string
  navigationKey: string
  operation: AuthOperationLease
}>

let memoryLease: AuthOperationLease | null = null
let activeWriter: AuthOperationLease | null = null
let redirectAcquisitionReceipt: AuthRedirectAcquisitionReceipt | null = null
let pendingPasswordRecoveryRedirect: PendingPasswordRecoveryRedirect | null = null
let leaseSequence = 0

const TRANSIENT_REDIRECT_PARAMS = new Set([
  'access_token',
  'code',
  'error',
  'error_code',
  'error_description',
  'expires_at',
  'expires_in',
  'provider_refresh_token',
  'provider_token',
  'refresh_token',
  'state',
  'token',
  'token_hash',
  'token_type',
  'type',
])

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function createLeaseId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  if (randomId) return randomId
  leaseSequence += 1
  return `${Date.now().toString(36)}-${leaseSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`
}

/**
 * Stable across Supabase removing a PKCE code or implicit-grant hash, while
 * retaining product intent such as addAccount and returnUrl.
 */
export function getAuthRedirectNavigationKey(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(window.location.href)
    for (const param of TRANSIENT_REDIRECT_PARAMS) url.searchParams.delete(param)
    url.searchParams.sort()
    const query = url.searchParams.toString()
    return `${url.pathname}${query ? `?${query}` : ''}`
  } catch {
    return null
  }
}

function navigationKeyFromUrl(url: URL): string {
  const normalized = new URL(url.toString())
  for (const param of TRANSIENT_REDIRECT_PARAMS) normalized.searchParams.delete(param)
  normalized.searchParams.sort()
  const query = normalized.searchParams.toString()
  return `${normalized.pathname}${query ? `?${query}` : ''}`
}

/**
 * Supabase clears an implicit-grant hash before it persists the acquired
 * session. Capture the exact recovery credentials at its detectSessionInUrl
 * boundary, then require the later storage write to match both tokens.
 */
export function detectAuthSessionInUrl(url: URL, params: Record<string, string>): boolean {
  rollbackPendingPasswordRecoveryRedirect()

  if (url.pathname === '/reset-password') {
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    const accessToken = hash.get('access_token')
    const refreshToken = hash.get('refresh_token')
    if (
      hash.get('type') === 'recovery' &&
      accessToken &&
      refreshToken &&
      params.type === 'recovery' &&
      params.access_token === accessToken &&
      params.refresh_token === refreshToken
    ) {
      pendingPasswordRecoveryRedirect = {
        accessToken,
        refreshToken,
        navigationKey: navigationKeyFromUrl(url),
        // Reserve ordering before GoTrue starts its asynchronous _getUser.
        // A later login/logout publishes a newer lease and makes this exact
        // recovery acquisition stale before it reaches the storage boundary.
        operation: beginAuthIdentityOperation(),
      }
    }
  }

  // Preserve GoTrue's default implicit-grant detection semantics for OAuth,
  // magic links, recovery errors, and every non-recovery route.
  return Boolean(params.access_token || params.error_description)
}

function storedSessionUserId(): string | null {
  const stored = getStoredAuthSession()
  return typeof stored?.user?.id === 'string' ? stored.user.id : null
}

function rollbackRecoveryOperation(operation: AuthOperationLease): void {
  if (!isAuthOperationCurrent(operation)) return
  const rebound = rebindAuthOperationPrincipal(operation, storedSessionUserId())
  if (rebound) completeAuthIdentityOperation(rebound, rebound.expectedUserId)
}

function rollbackPendingPasswordRecoveryRedirect(): void {
  const pending = pendingPasswordRecoveryRedirect
  pendingPasswordRecoveryRedirect = null
  if (pending) rollbackRecoveryOperation(pending.operation)
}

/**
 * Called after GoTrue initialization resolves. An invalid/reused recovery URL
 * never reaches storage, so restore the prior stored principal instead of
 * leaving the provisional redirect lease as a permanent pending transition.
 */
export function settleAuthRedirectInitialization(): void {
  rollbackPendingPasswordRecoveryRedirect()
}

export function getAuthRedirectAcquisitionReceipt(): AuthRedirectAcquisitionReceipt | null {
  return redirectAcquisitionReceipt ? { ...redirectAcquisitionReceipt } : null
}

/**
 * Compare-and-clear prevents an old callback holding receipt A from clearing a
 * newer receipt B that was installed while A's async work was still pending.
 */
export function clearAuthRedirectAcquisitionReceipt(
  expected: AuthRedirectAcquisitionReceipt
): boolean {
  const current = redirectAcquisitionReceipt
  if (
    !current ||
    current.operationId !== expected.operationId ||
    current.userId !== expected.userId ||
    current.navigationKey !== expected.navigationKey ||
    current.purpose !== expected.purpose
  ) {
    return false
  }
  redirectAcquisitionReceipt = null
  return true
}

export function parseAuthOperationLease(value: string | null): AuthOperationLease | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<AuthOperationLease>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.targetKnown !== 'boolean' ||
      typeof parsed.identityTransition !== 'boolean' ||
      (parsed.expectedUserId !== null && typeof parsed.expectedUserId !== 'string')
    ) {
      return null
    }
    return {
      id: parsed.id,
      expectedUserId: parsed.expectedUserId,
      targetKnown: parsed.targetKnown,
      identityTransition: parsed.identityTransition,
    }
  } catch {
    return null
  }
}

function parseAuthOperationPointer(value: string | null): StoredAuthOperationPointer | null {
  const lease = parseAuthOperationLease(value)
  if (!lease || !value) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredAuthOperationPointer>
    if (parsed.stableSessionKey !== stableSessionKey(lease.id)) return null
    return { ...lease, stableSessionKey: parsed.stableSessionKey }
  } catch {
    return null
  }
}

function operationStateKey(operationId: string): string {
  return `${AUTH_OPERATION_STATE_STORAGE_PREFIX}${operationId}`
}

function sessionIntentKey(operationId: string): string {
  return `${AUTH_SESSION_INTENT_STORAGE_PREFIX}${operationId}`
}

function stableSessionKey(operationId: string): string {
  return `${AUTH_SESSION_BASE_STORAGE_PREFIX}${operationId}`
}

function parseStableSession(value: string | null, operationId: string): StoredStableSession | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredStableSession>
    if (
      parsed.operationId !== operationId ||
      (parsed.value !== null && typeof parsed.value !== 'string')
    ) {
      return null
    }
    return { operationId, value: parsed.value }
  } catch {
    return null
  }
}

function parseSessionIntent(value: string | null, operationId: string): AuthSessionIntent | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<AuthSessionIntent>
    if (
      parsed.operationId !== operationId ||
      typeof parsed.writeId !== 'string' ||
      (parsed.expectedUserId !== null && typeof parsed.expectedUserId !== 'string') ||
      (parsed.value !== null && typeof parsed.value !== 'string')
    ) {
      return null
    }
    return {
      operationId,
      writeId: parsed.writeId,
      expectedUserId: parsed.expectedUserId,
      value: parsed.value,
    }
  } catch {
    return null
  }
}

export function getCurrentAuthOperation(): AuthOperationLease | null {
  const authStorage = storage()
  if (!authStorage) return memoryLease
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pointerRaw = authStorage.getItem(AUTH_OPERATION_STORAGE_KEY)
      const pointer = parseAuthOperationLease(pointerRaw)
      if (!pointer) return null
      const state = parseAuthOperationLease(authStorage.getItem(operationStateKey(pointer.id)))
      if (authStorage.getItem(AUTH_OPERATION_STORAGE_KEY) === pointerRaw) {
        return state?.id === pointer.id ? state : pointer
      }
    }
    return null
  } catch {
    return memoryLease
  }
}

/**
 * Publish the operation pointer exactly once. Later bind/complete updates use
 * the operation's unique state key, so an old check-then-update can never
 * overwrite a newer operation pointer from another tab.
 */
function publishLease(lease: AuthOperationLease): AuthOperationLease {
  memoryLease = lease
  const authStorage = storage()
  if (authStorage) {
    const baseKey = stableSessionKey(lease.id)
    let baseRaw: string | null = null
    try {
      const previous = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
      const stableSession = authStorage.getItem(AUTH_STORAGE_KEY)
      baseRaw = JSON.stringify({ operationId: lease.id, value: stableSession })
      const pointer: StoredAuthOperationPointer = { ...lease, stableSessionKey: baseKey }
      authStorage.setItem(baseKey, baseRaw)
      authStorage.setItem(AUTH_OPERATION_STORAGE_KEY, JSON.stringify(pointer))

      const published =
        parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))?.id === lease.id
      if (!published && authStorage.getItem(baseKey) === baseRaw) {
        authStorage.removeItem(baseKey)
      }

      // Only the winning pointer may discard its predecessor's token journal.
      // A stale writer can still recreate its own record, but it can never make
      // that record authoritative because desired sessions are selected by the
      // immutable current pointer.
      if (previous && previous.id !== lease.id) {
        const current = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
        if (current?.id === lease.id) {
          authStorage.removeItem(operationStateKey(previous.id))
          authStorage.removeItem(sessionIntentKey(previous.id))
          authStorage.removeItem(stableSessionKey(previous.id))
        }
      }
    } catch {
      try {
        const current = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
        if (
          baseRaw !== null &&
          current?.id !== lease.id &&
          authStorage.getItem(baseKey) === baseRaw
        ) {
          authStorage.removeItem(baseKey)
        }
      } catch {
        // The storage backend is unavailable; no further cleanup is possible.
      }
      // The in-memory lease still protects this tab when storage is unavailable.
    }
  }
  return lease
}

function publishLeaseState(lease: AuthOperationLease): AuthOperationLease | null {
  const authStorage = storage()
  if (!authStorage) {
    if (memoryLease?.id !== lease.id) return null
    memoryLease = lease
    return lease
  }

  const raw = JSON.stringify(lease)
  try {
    const pointer = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
    if (pointer?.id !== lease.id) return null
    authStorage.setItem(operationStateKey(lease.id), raw)
    const current = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
    const storedState = authStorage.getItem(operationStateKey(lease.id))
    if (current?.id !== lease.id || storedState !== raw) {
      if (current?.id !== lease.id && storedState === raw) {
        authStorage.removeItem(operationStateKey(lease.id))
      }
      return null
    }
    memoryLease = lease
    return lease
  } catch {
    return null
  }
}

export function beginAuthIdentityOperation(expectedUserId?: string | null): AuthOperationLease {
  return publishLease({
    id: createLeaseId(),
    expectedUserId: expectedUserId ?? null,
    targetKnown: expectedUserId !== undefined,
    identityTransition: true,
  })
}

/** Capture the steady-state epoch without invalidating same-principal work. */
export function captureAuthOperation(expectedUserId: string): AuthOperationLease | null {
  const current = getCurrentAuthOperation()
  if (current) {
    if (!current.targetKnown || current.expectedUserId !== expectedUserId) return null
    const authStorage = storage()
    if (authStorage && !current.identityTransition) {
      try {
        if (
          parseAuthOperationPointer(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))?.id !==
          current.id
        ) {
          // Upgrade a steady-state lease left by an older bundle so its next
          // write also has an exact recovery journal.
          return publishLease({ ...current, id: createLeaseId() })
        }
      } catch {
        return null
      }
    }
    return current
  }
  return publishLease({
    id: createLeaseId(),
    expectedUserId,
    targetKnown: true,
    identityTransition: false,
  })
}

export function isAuthOperationCurrent(lease: AuthOperationLease): boolean {
  return getCurrentAuthOperation()?.id === lease.id
}

export function bindAuthOperationPrincipal(
  lease: AuthOperationLease,
  userId: string | null
): AuthOperationLease | null {
  const current = getCurrentAuthOperation()
  if (!current || current.id !== lease.id) return null
  if (current.targetKnown && current.expectedUserId !== userId) return null
  if (current.targetKnown) return current
  const bound = { ...current, expectedUserId: userId, targetKnown: true }
  return publishLeaseState(bound)
}

/** Restore the session that remained in storage after a failed target switch. */
export function rebindAuthOperationPrincipal(
  lease: AuthOperationLease,
  userId: string | null
): AuthOperationLease | null {
  const current = getCurrentAuthOperation()
  if (!current || current.id !== lease.id) return null
  if (!current.identityTransition) {
    return current.targetKnown && current.expectedUserId === userId ? current : null
  }
  return publishLeaseState({ ...current, expectedUserId: userId, targetKnown: true })
}

export function completeAuthIdentityOperation(
  lease: AuthOperationLease,
  userId: string | null
): AuthOperationLease | null {
  const current = getCurrentAuthOperation()
  if (!current || current.id !== lease.id) return null
  if (current.targetKnown && current.expectedUserId !== userId) return null
  if (!current.identityTransition) return current
  return publishLeaseState({
    ...current,
    expectedUserId: userId,
    targetKnown: true,
    identityTransition: false,
  })
}

export function isSessionAllowedForCurrentAuthOperation(userId: string | null): boolean {
  const current = getCurrentAuthOperation()
  if (!current) return true
  return current.targetKnown && current.expectedUserId === userId
}

/**
 * Session writers are serialized by the coordinator, so this context remains
 * unambiguous across the awaited Supabase method and its internal storage call.
 */
export async function withAuthSessionWriter<T>(
  lease: AuthOperationLease,
  writer: () => Promise<T>
): Promise<T> {
  if (activeWriter) throw new Error('Concurrent auth session writer')
  activeWriter = lease
  try {
    return await writer()
  } finally {
    if (activeWriter?.id === lease.id) activeWriter = null
  }
}

function parseStoredSession(value: string): StoredSession | null {
  try {
    return JSON.parse(value) as StoredSession
  } catch {
    return null
  }
}

function getPasswordRecoveryRedirectWriter(session: StoredSession): AuthOperationLease | null {
  if (typeof window === 'undefined') return null
  const recovery = pendingPasswordRecoveryRedirect
  if (
    window.location.pathname === '/reset-password' &&
    recovery &&
    recovery.navigationKey === getAuthRedirectNavigationKey() &&
    session.access_token === recovery.accessToken &&
    session.refresh_token === recovery.refreshToken
  ) {
    return recovery.operation
  }
  return null
}

type DesiredAuthSession = Readonly<{
  operationId: string
  version: string
  value: string | null
}>

function isAuthOperationPrincipalCurrent(lease: AuthOperationLease): boolean {
  const current = getCurrentAuthOperation()
  return (
    current?.id === lease.id &&
    current.targetKnown === lease.targetKnown &&
    current.expectedUserId === lease.expectedUserId
  )
}

function publishSessionIntent(
  authStorage: Storage,
  lease: AuthOperationLease,
  value: string | null
): AuthSessionIntent | null {
  const intent: AuthSessionIntent = {
    operationId: lease.id,
    writeId: createLeaseId(),
    expectedUserId: lease.expectedUserId,
    value,
  }
  const raw = JSON.stringify(intent)

  try {
    if (!isAuthOperationPrincipalCurrent(lease)) return null
    authStorage.setItem(sessionIntentKey(lease.id), raw)

    const storedIntent = authStorage.getItem(sessionIntentKey(lease.id))
    if (isAuthOperationPrincipalCurrent(lease) && storedIntent === raw) return intent

    if (storedIntent === raw) authStorage.removeItem(sessionIntentKey(lease.id))
    return null
  } catch {
    return null
  }
}

function isSessionIntentCurrent(authStorage: Storage, intent: AuthSessionIntent): boolean {
  try {
    const pointerRaw = authStorage.getItem(AUTH_OPERATION_STORAGE_KEY)
    const pointer = parseAuthOperationLease(pointerRaw)
    const stateRaw = pointer ? authStorage.getItem(operationStateKey(pointer.id)) : null
    const state = parseAuthOperationLease(stateRaw) ?? pointer
    const current = parseSessionIntent(
      authStorage.getItem(sessionIntentKey(intent.operationId)),
      intent.operationId
    )
    return (
      pointer?.id === intent.operationId &&
      state?.targetKnown === true &&
      state.expectedUserId === intent.expectedUserId &&
      current?.writeId === intent.writeId &&
      authStorage.getItem(AUTH_OPERATION_STORAGE_KEY) === pointerRaw &&
      authStorage.getItem(operationStateKey(intent.operationId)) === stateRaw
    )
  } catch {
    return false
  }
}

function desiredAuthSession(authStorage: Storage): DesiredAuthSession | null {
  try {
    const pointerRaw = authStorage.getItem(AUTH_OPERATION_STORAGE_KEY)
    const pointer = parseAuthOperationPointer(pointerRaw)
    if (!pointer) return null
    const stateRaw = authStorage.getItem(operationStateKey(pointer.id))
    const state = parseAuthOperationLease(stateRaw) ?? pointer
    const intent = parseSessionIntent(authStorage.getItem(sessionIntentKey(pointer.id)), pointer.id)
    const stable = parseStableSession(authStorage.getItem(pointer.stableSessionKey), pointer.id)
    if (
      authStorage.getItem(AUTH_OPERATION_STORAGE_KEY) !== pointerRaw ||
      authStorage.getItem(operationStateKey(pointer.id)) !== stateRaw
    ) {
      return null
    }
    if (intent && state.targetKnown && intent.expectedUserId === state.expectedUserId) {
      return {
        operationId: pointer.id,
        version: `intent:${intent.writeId}`,
        value: intent.value,
      }
    }
    return stable
      ? {
          operationId: pointer.id,
          version: 'stable',
          value: stable.value,
        }
      : null
  } catch {
    return null
  }
}

function sameDesiredSession(a: DesiredAuthSession | null, b: DesiredAuthSession | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.operationId === b.operationId &&
    a.version === b.version &&
    a.value === b.value
  )
}

/**
 * Repair a canonical write that lost a race with a newer operation. The
 * winner's exact value is read from its own immutable-key journal; after every
 * restore we re-read the journal so a token rotation that raced the restore is
 * applied instead of being replaced by an older snapshot.
 */
function reconcileCanonicalAuthSession(authStorage: Storage): boolean {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const desired = desiredAuthSession(authStorage)
    if (!desired) return false

    if (authStorage.getItem(AUTH_STORAGE_KEY) !== desired.value) {
      if (desired.value === null) authStorage.removeItem(AUTH_STORAGE_KEY)
      else authStorage.setItem(AUTH_STORAGE_KEY, desired.value)
    }

    const verified = desiredAuthSession(authStorage)
    if (
      sameDesiredSession(desired, verified) &&
      authStorage.getItem(AUTH_STORAGE_KEY) === desired.value
    ) {
      return true
    }
  }

  // Sustained cross-tab churn should not pin the browser's main thread. Every
  // winning writer also reconciles synchronously; this retry covers the rare
  // case where all 32 snapshots changed underneath this stale writer.
  queueMicrotask(() => reconcileCanonicalAuthSession(authStorage))
  return false
}

function discardStaleSessionIntent(authStorage: Storage, intent: AuthSessionIntent): void {
  try {
    const key = sessionIntentKey(intent.operationId)
    const raw = authStorage.getItem(key)
    if (parseSessionIntent(raw, intent.operationId)?.writeId === intent.writeId) {
      const current = parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
      if (current?.id !== intent.operationId) authStorage.removeItem(key)
    }
  } catch {
    // Cleanup is best-effort; the next winning operation also removes it.
  }
}

/**
 * Storage passed to the shared Supabase client. Only the canonical session key
 * is guarded; PKCE verifier writes remain owned by Supabase's OAuth flow.
 */
export const guardedAuthStorage = {
  getItem(key: string): string | null {
    try {
      return storage()?.getItem(key) ?? null
    } catch {
      return null
    }
  },

  setItem(key: string, value: string): void {
    const authStorage = storage()
    if (!authStorage) return
    if (key !== AUTH_STORAGE_KEY) {
      authStorage.setItem(key, value)
      return
    }

    const session = parseStoredSession(value)
    const userId = typeof session?.user?.id === 'string' ? session.user.id : null
    if (!userId) return

    // OAuth URL detection is performed internally by Supabase rather than by
    // one of our wrappers. Treat that one unscoped acquisition as an identity
    // operation, which also invalidates old refreshes in other tabs.
    let writer = activeWriter
    const internalRedirectWriter = !writer
    let redirectPurpose: AuthRedirectAcquisitionReceipt['purpose'] | null = null
    if (!writer) {
      const recoveryWriter = session ? getPasswordRecoveryRedirectWriter(session) : null
      if (recoveryWriter) {
        pendingPasswordRecoveryRedirect = null
        if (!isAuthOperationCurrent(recoveryWriter)) return
        writer = recoveryWriter
        redirectPurpose = 'password-recovery'
      } else if (window.location.pathname === '/auth/callback') {
        rollbackPendingPasswordRecoveryRedirect()
        writer = beginAuthIdentityOperation(userId)
        redirectPurpose = 'oauth-callback'
      } else {
        rollbackPendingPasswordRecoveryRedirect()
        return
      }
    }

    const bound = bindAuthOperationPrincipal(writer, userId)
    if (!bound || !isAuthOperationCurrent(bound)) return

    // Publish the winner's exact session before touching the shared canonical
    // key. Because this key is unique to the operation, a stale A writer cannot
    // overwrite B's recovery value even if A resumes inside localStorage.setItem.
    const intent = publishSessionIntent(authStorage, bound, value)
    if (!intent || !isSessionIntentCurrent(authStorage, intent)) {
      reconcileCanonicalAuthSession(authStorage)
      return
    }

    authStorage.setItem(key, value)

    // localStorage operations are atomic individually, not as a transaction.
    // Reconcile from the current operation's exact intent rather than deleting
    // this value or restoring an arbitrary earlier token.
    const reconciled = reconcileCanonicalAuthSession(authStorage)
    const stillOwnsWrite =
      isAuthOperationCurrent(bound) && isSessionIntentCurrent(authStorage, intent)
    if (!reconciled || !stillOwnsWrite) {
      discardStaleSessionIntent(authStorage, intent)
      return
    }
    authStorage.removeItem(stableSessionKey(bound.id))
    if (internalRedirectWriter) {
      const completed = completeAuthIdentityOperation(bound, userId)
      const navigationKey = getAuthRedirectNavigationKey()
      if (completed && navigationKey && redirectPurpose) {
        redirectAcquisitionReceipt = {
          operationId: completed.id,
          userId,
          navigationKey,
          purpose: redirectPurpose,
        }
      }
    }
  },

  removeItem(key: string): void {
    const authStorage = storage()
    if (!authStorage) return
    if (key !== AUTH_STORAGE_KEY && key !== `${AUTH_STORAGE_KEY}-user`) {
      authStorage.removeItem(key)
    }
    // Canonical session removal is performed explicitly after an operation CAS.
    // Ignoring implicit removal prevents an old refresh failure from deleting B.
  },
}

export function clearAuthStorage(lease: AuthOperationLease): boolean {
  if (!isAuthOperationCurrent(lease)) return false
  const authStorage = storage()
  if (!authStorage) return true
  try {
    const intent = publishSessionIntent(authStorage, lease, null)
    if (!intent || !isSessionIntentCurrent(authStorage, intent)) {
      reconcileCanonicalAuthSession(authStorage)
      return false
    }
    authStorage.removeItem(AUTH_STORAGE_KEY)
    const reconciled = reconcileCanonicalAuthSession(authStorage)
    const stillOwnsClear =
      isAuthOperationCurrent(lease) && isSessionIntentCurrent(authStorage, intent)
    if (!stillOwnsClear) {
      discardStaleSessionIntent(authStorage, intent)
      return false
    }
    if (!reconciled) return false
    authStorage.removeItem(stableSessionKey(lease.id))

    // These companion values are only cleared after the canonical null intent
    // is proven current. The guarded adapter ignores later stale removals.
    authStorage.removeItem(`${AUTH_STORAGE_KEY}-user`)
    authStorage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`)
    return true
  } catch {
    return false
  }
}

export function getStoredAuthSession(): StoredSession | null {
  const raw = guardedAuthStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredSession
  } catch {
    return null
  }
}

export function __resetAuthOperationsForTests(): void {
  memoryLease = null
  activeWriter = null
  redirectAcquisitionReceipt = null
  pendingPasswordRecoveryRedirect = null
  leaseSequence = 0
  const authStorage = storage()
  try {
    authStorage?.removeItem(AUTH_OPERATION_STORAGE_KEY)
    authStorage?.removeItem(AUTH_STORAGE_KEY)
    authStorage?.removeItem(`${AUTH_STORAGE_KEY}-user`)
    authStorage?.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`)
    if (authStorage) {
      for (let index = authStorage.length - 1; index >= 0; index -= 1) {
        const key = authStorage.key(index)
        if (
          key?.startsWith(AUTH_OPERATION_STATE_STORAGE_PREFIX) ||
          key?.startsWith(AUTH_SESSION_INTENT_STORAGE_PREFIX) ||
          key?.startsWith(AUTH_SESSION_BASE_STORAGE_PREFIX)
        ) {
          authStorage.removeItem(key)
        }
      }
    }
  } catch {
    // Test environments without functional storage use the in-memory reset.
  }
}
