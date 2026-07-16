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
}>

type StoredSession = {
  access_token?: unknown
  refresh_token?: unknown
  user?: { id?: unknown }
}

let memoryLease: AuthOperationLease | null = null
let activeWriter: AuthOperationLease | null = null
let redirectAcquisitionReceipt: AuthRedirectAcquisitionReceipt | null = null
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
    current.navigationKey !== expected.navigationKey
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

export function getCurrentAuthOperation(): AuthOperationLease | null {
  const authStorage = storage()
  if (!authStorage) return memoryLease
  try {
    return parseAuthOperationLease(authStorage.getItem(AUTH_OPERATION_STORAGE_KEY))
  } catch {
    return memoryLease
  }
}

function publishLease(lease: AuthOperationLease): AuthOperationLease {
  memoryLease = lease
  const authStorage = storage()
  if (authStorage) {
    try {
      authStorage.setItem(AUTH_OPERATION_STORAGE_KEY, JSON.stringify(lease))
    } catch {
      // The in-memory lease still protects this tab when storage is unavailable.
    }
  }
  return lease
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
  if (!isAuthOperationCurrent(lease)) return null
  if (lease.targetKnown && lease.expectedUserId !== userId) return null
  if (lease.targetKnown) return lease
  const bound = { ...lease, expectedUserId: userId, targetKnown: true }
  return publishLease(bound)
}

/** Restore the session that remained in storage after a failed target switch. */
export function rebindAuthOperationPrincipal(
  lease: AuthOperationLease,
  userId: string | null
): AuthOperationLease | null {
  if (!isAuthOperationCurrent(lease)) return null
  return publishLease({ ...lease, expectedUserId: userId, targetKnown: true })
}

export function completeAuthIdentityOperation(
  lease: AuthOperationLease,
  userId: string | null
): AuthOperationLease | null {
  if (!isAuthOperationCurrent(lease)) return null
  return publishLease({
    ...lease,
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

function sessionUserId(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as StoredSession
    return typeof parsed.user?.id === 'string' ? parsed.user.id : null
  } catch {
    return null
  }
}

function isOAuthCallbackAcquisition(): boolean {
  return typeof window !== 'undefined' && window.location.pathname === '/auth/callback'
}

function isAuthRedirectAcquisition(): boolean {
  if (typeof window === 'undefined') return false
  return isOAuthCallbackAcquisition() || window.location.pathname === '/reset-password'
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

    const userId = sessionUserId(value)
    if (!userId) return

    // OAuth URL detection is performed internally by Supabase rather than by
    // one of our wrappers. Treat that one unscoped acquisition as an identity
    // operation, which also invalidates old refreshes in other tabs.
    let writer = activeWriter
    const internalRedirectWriter = !writer
    if (!writer) {
      if (!isAuthRedirectAcquisition()) return
      writer = beginAuthIdentityOperation(userId)
    }

    const bound = bindAuthOperationPrincipal(writer, userId)
    if (!bound || !isAuthOperationCurrent(bound)) return

    authStorage.setItem(key, value)

    // localStorage operations are atomic individually, not as a pair. Re-check
    // after the write so a cross-tab transition between CAS and set cannot leave
    // this stale value behind. Never remove a newer value written by the winner.
    if (!isAuthOperationCurrent(bound) && authStorage.getItem(key) === value) {
      authStorage.removeItem(key)
      return
    }
    if (internalRedirectWriter) {
      const completed = completeAuthIdentityOperation(bound, userId)
      const navigationKey = isOAuthCallbackAcquisition() ? getAuthRedirectNavigationKey() : null
      if (completed && navigationKey) {
        redirectAcquisitionReceipt = {
          operationId: completed.id,
          userId,
          navigationKey,
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
    authStorage.removeItem(AUTH_STORAGE_KEY)
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
  leaseSequence = 0
  const authStorage = storage()
  try {
    authStorage?.removeItem(AUTH_OPERATION_STORAGE_KEY)
    authStorage?.removeItem(AUTH_STORAGE_KEY)
    authStorage?.removeItem(`${AUTH_STORAGE_KEY}-user`)
    authStorage?.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`)
  } catch {
    // Test environments without functional storage use the in-memory reset.
  }
}
