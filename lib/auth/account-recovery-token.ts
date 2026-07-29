export const ACCOUNT_RECOVERY_TOKEN_KEY = 'arena_account_recovery_token'
export const ACCOUNT_RECOVERY_SESSION_TOKEN_KEY = 'arena_account_recovery_session_token'
export const ACCOUNT_RECOVERY_MEMORY_KEY = '__arenaAccountRecoveryHandoff'
export const ACCOUNT_RECOVERY_LOGIN_PATH = '/login?account_deleted=1'

const RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

export type AccountRecoveryTokenHandoff =
  | Readonly<{ status: 'valid'; token: string }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'invalid' }>

type MemoryRecoveryTokenHandoff =
  | Readonly<{ status: 'valid'; token: string }>
  | Readonly<{ status: 'invalid' }>

export type AccountRecoveryTokenPersistence = Readonly<{
  status: 'durable' | 'memory' | 'unavailable' | 'invalid'
  localStorage: boolean
  sessionStorage: boolean
}>

declare global {
  interface Window {
    __arenaAccountRecoveryHandoff?: MemoryRecoveryTokenHandoff
  }
}

// Next can remount a static login subtree when its search params hydrate. Once
// a credential has been removed from storage/URL, this route-scoped module lease
// lets the replacement subtree claim the same handoff without re-persisting
// plaintext. Route departure, pagehide and explicit terminal actions clear it.
let recoveryHandoffLease: AccountRecoveryTokenHandoff | null = null
let recoveryLeaseHolderCount = 0
let recoveryLeaseReleaseTimer: ReturnType<typeof setTimeout> | null = null
let recoveryPageHideListenerInstalled = false

function cancelRecoveryLeaseRelease(): void {
  if (recoveryLeaseReleaseTimer === null) return
  clearTimeout(recoveryLeaseReleaseTimer)
  recoveryLeaseReleaseTimer = null
}

function rememberRecoveryHandoff(handoff: MemoryRecoveryTokenHandoff): AccountRecoveryTokenHandoff {
  cancelRecoveryLeaseRelease()
  recoveryHandoffLease = handoff
  return handoff
}

function clearRecoveryHandoffLease(): void {
  cancelRecoveryLeaseRelease()
  recoveryHandoffLease = null
}

function isRecoveryLoginLocation(): boolean {
  if (typeof window === 'undefined' || window.location.pathname !== '/login') return false
  try {
    const search = new URLSearchParams(window.location.search)
    return search.get('account_deleted') === '1' || search.get('recover') === '1'
  } catch {
    return false
  }
}

function installRecoveryPageHideCleanup(): void {
  if (recoveryPageHideListenerInstalled || typeof window === 'undefined') return
  recoveryPageHideListenerInstalled = true
  window.addEventListener('pagehide', () => {
    // The listener survives SPA navigation. Do not erase durable lanes here:
    // a later settings deletion may have staged them just before a hard
    // navigation/tab close. Only ephemeral state belongs to this JS realm.
    clearRecoveryHandoffLease()
    removeMemoryRecoveryToken()
  })
}

function scheduleRecoveryRouteDepartureCheck(delayMs: number): void {
  recoveryLeaseReleaseTimer = setTimeout(() => {
    recoveryLeaseReleaseTimer = null
    if (recoveryLeaseHolderCount > 0 || recoveryHandoffLease === null) return
    if (!isRecoveryLoginLocation()) {
      clearAccountRecoveryToken()
      return
    }

    // A Suspense/search-param replacement may leave no holder for an
    // unbounded interval on a slow/backgrounded tab. Preserve by URL state,
    // while continuing to notice a later SPA departure.
    scheduleRecoveryRouteDepartureCheck(250)
  }, delayMs)
}

/**
 * Hold the in-memory handoff across a transient React/Next remount.
 *
 * The returned cleanup erases only when the last mounted login subtree has
 * also left the recovery URL. Same-URL replacements can reclaim indefinitely.
 */
export function retainAccountRecoveryTokenLease(): () => void {
  cancelRecoveryLeaseRelease()
  installRecoveryPageHideCleanup()
  recoveryLeaseHolderCount += 1
  let released = false

  return () => {
    if (released) return
    released = true
    recoveryLeaseHolderCount = Math.max(0, recoveryLeaseHolderCount - 1)
    if (recoveryLeaseHolderCount > 0 || recoveryHandoffLease === null) return

    scheduleRecoveryRouteDepartureCheck(0)
  }
}

/**
 * Recovery credentials are canonical, unpadded base64url strings.
 *
 * The character/length checks alone are insufficient: a length of 1 mod 4
 * cannot be decoded, while non-zero unused trailing bits produce a different
 * string when encoded again. The round trip rejects both cases.
 */
export function isAccountRecoveryToken(value: string | null | undefined): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 40 ||
    value.length > 128 ||
    value.length % 4 === 1 ||
    !RECOVERY_TOKEN_PATTERN.test(value) ||
    typeof globalThis.atob !== 'function' ||
    typeof globalThis.btoa !== 'function'
  ) {
    return false
  }

  try {
    const standard = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = `${standard}${'='.repeat((4 - (standard.length % 4)) % 4)}`
    const decoded = globalThis.atob(padded)
    const canonical = globalThis
      .btoa(decoded)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '')
    return canonical === value
  } catch {
    return false
  }
}

function removeStorageToken(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // Each handoff lane is independent.
  }
}

function removeStoredRecoveryTokens(): void {
  try {
    removeStorageToken(window.localStorage, ACCOUNT_RECOVERY_TOKEN_KEY)
  } catch {
    // Accessing a disabled Storage getter can itself throw.
  }
  try {
    removeStorageToken(window.sessionStorage, ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)
  } catch {
    // Each storage lane is independent.
  }
}

function removeMemoryRecoveryToken(): void {
  try {
    delete window.__arenaAccountRecoveryHandoff
  } catch {
    try {
      window.__arenaAccountRecoveryHandoff = undefined
    } catch {
      // A hardened Window may reject extension; storage lanes still work.
    }
  }
}

function writeMemoryRecoveryToken(handoff: MemoryRecoveryTokenHandoff): boolean {
  try {
    Object.defineProperty(window, ACCOUNT_RECOVERY_MEMORY_KEY, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: handoff,
    })
    return window.__arenaAccountRecoveryHandoff === handoff
  } catch {
    try {
      window.__arenaAccountRecoveryHandoff = handoff
      return window.__arenaAccountRecoveryHandoff === handoff
    } catch {
      return false
    }
  }
}

function takeMemoryRecoveryToken(): AccountRecoveryTokenHandoff {
  let handoff: MemoryRecoveryTokenHandoff | undefined
  try {
    handoff = window.__arenaAccountRecoveryHandoff
  } catch {
    return { status: 'absent' }
  } finally {
    removeMemoryRecoveryToken()
  }

  if (!handoff) return { status: 'absent' }
  if (handoff.status === 'invalid') return { status: 'invalid' }
  return isAccountRecoveryToken(handoff.token)
    ? { status: 'valid', token: handoff.token }
    : { status: 'invalid' }
}

function writeStorageToken(storage: Storage, key: string, token: string): boolean {
  try {
    storage.setItem(key, token)
    if (storage.getItem(key) === token) return true
  } catch {
    // Cleanup below covers writes that succeeded before a readback failure.
  }
  removeStorageToken(storage, key)
  return false
}

function readStorageToken(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalRecoveryToken(token: string): boolean {
  try {
    return writeStorageToken(window.localStorage, ACCOUNT_RECOVERY_TOKEN_KEY, token)
  } catch {
    return false
  }
}

function writeSessionRecoveryToken(token: string): boolean {
  try {
    return writeStorageToken(window.sessionStorage, ACCOUNT_RECOVERY_SESSION_TOKEN_KEY, token)
  } catch {
    return false
  }
}

function readLocalRecoveryToken(): string | null {
  try {
    return readStorageToken(window.localStorage, ACCOUNT_RECOVERY_TOKEN_KEY)
  } catch {
    return null
  }
}

function readSessionRecoveryToken(): string | null {
  try {
    return readStorageToken(window.sessionStorage, ACCOUNT_RECOVERY_SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

function removeFragmentRecoveryToken(fragment: URLSearchParams): boolean {
  fragment.delete('recovery_token')
  const remainingFragment = fragment.toString()

  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${
        remainingFragment ? `#${remainingFragment}` : ''
      }`
    )
    return true
  } catch {
    return false
  }
}

/**
 * Stage a one-time credential without putting it in a client-routed URL.
 *
 * Memory handles the current SPA document, localStorage preserves cross-tab
 * recovery, and sessionStorage independently preserves same-tab reloads when
 * localStorage is blocked. Raw lanes are consumed and cleared on login, then a
 * route-scoped module lease survives framework-driven subtree replacement.
 */
export function persistAccountRecoveryToken(token: string): AccountRecoveryTokenPersistence {
  if (typeof window === 'undefined') {
    return {
      status: 'invalid',
      localStorage: false,
      sessionStorage: false,
    }
  }

  clearRecoveryHandoffLease()
  removeMemoryRecoveryToken()
  removeStoredRecoveryTokens()

  if (!isAccountRecoveryToken(token)) {
    return {
      status: 'invalid',
      localStorage: false,
      sessionStorage: false,
    }
  }

  const memory = writeMemoryRecoveryToken({ status: 'valid', token })
  const localStorage = writeLocalRecoveryToken(token)
  const sessionStorage = writeSessionRecoveryToken(token)

  return {
    status: localStorage || sessionStorage ? 'durable' : memory ? 'memory' : 'unavailable',
    localStorage,
    sessionStorage,
  }
}

/** The normal SPA transition is always credential-free. */
export function buildAccountRecoveryLoginPath(): string {
  return ACCOUNT_RECOVERY_LOGIN_PATH
}

/**
 * Last-resort full-document handoff when both storage APIs are unavailable.
 *
 * This target must never be passed to a client router/history API. The root
 * parser bootstrap strips and consumes it before Sentry, Replay or hydration.
 */
export function replaceDocumentForAccountRecovery(
  token: string,
  replace?: (target: string) => void
): boolean {
  if (!isAccountRecoveryToken(token) || typeof window === 'undefined') return false
  const navigate = replace ?? ((target: string) => window.location.replace(target))
  navigate(`${ACCOUNT_RECOVERY_LOGIN_PATH}#recovery_token=${encodeURIComponent(token)}`)
  return true
}

/**
 * Consume the recovery handoff into component memory plus a remount-safe lease.
 *
 * An explicit fragment or parser-bootstrap marker is authoritative even when
 * malformed. Storage values must be individually valid and agree, preventing
 * an older credential from recovering the wrong account.
 */
export function consumeAccountRecoveryToken(): AccountRecoveryTokenHandoff {
  if (typeof window === 'undefined') return { status: 'absent' }

  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    if (fragment.has('recovery_token')) {
      const fragmentTokens = fragment.getAll('recovery_token')
      const fragmentToken = fragmentTokens.length === 1 ? fragmentTokens[0] : null
      removeMemoryRecoveryToken()
      removeStoredRecoveryTokens()

      if (!removeFragmentRecoveryToken(fragment)) {
        return rememberRecoveryHandoff({ status: 'invalid' })
      }
      return rememberRecoveryHandoff(
        fragmentTokens.length === 1 && isAccountRecoveryToken(fragmentToken)
          ? { status: 'valid', token: fragmentToken }
          : { status: 'invalid' }
      )
    }
  } catch {
    if (window.location.hash) {
      removeMemoryRecoveryToken()
      removeStoredRecoveryTokens()
      return rememberRecoveryHandoff({ status: 'invalid' })
    }
  }

  const memoryHandoff = takeMemoryRecoveryToken()
  if (memoryHandoff.status !== 'absent') {
    removeStoredRecoveryTokens()
    return rememberRecoveryHandoff(memoryHandoff)
  }

  const localToken = readLocalRecoveryToken()
  const sessionToken = readSessionRecoveryToken()
  removeStoredRecoveryTokens()

  const presentTokens = [localToken, sessionToken].filter(
    (value): value is string => value !== null
  )
  if (presentTokens.length === 0) {
    return recoveryHandoffLease ?? { status: 'absent' }
  }
  if (
    presentTokens.some((value) => !isAccountRecoveryToken(value)) ||
    presentTokens.some((value) => value !== presentTokens[0])
  ) {
    return rememberRecoveryHandoff({ status: 'invalid' })
  }
  return rememberRecoveryHandoff({ status: 'valid', token: presentTokens[0] })
}

export function clearAccountRecoveryToken(): void {
  clearRecoveryHandoffLease()
  if (typeof window === 'undefined') return

  removeMemoryRecoveryToken()
  removeStoredRecoveryTokens()

  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1))
    if (!fragment.has('recovery_token')) return
    removeFragmentRecoveryToken(fragment)
  } catch {
    // Cleanup is best-effort on terminal/cancellation paths.
  }
}
