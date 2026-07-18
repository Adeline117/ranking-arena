import { safeInternalReturnPath } from './safe-return-path'

export const PROFILE_ACTION_QUERY_PARAM = 'resumeAction'

const STORAGE_KEY = 'arena:pending-profile-action'
const MAX_PENDING_AGE_MS = 15 * 60 * 1000
const URL_BASE = 'https://arena.invalid'

export type ProfileActionIntent =
  | 'follow-user'
  | 'unfollow-user'
  | 'message-user'
  | 'follow-trader'
  | 'unfollow-trader'
  | 'watch-trader'
  | 'unwatch-trader'
  | 'claim-trader'

type PendingProfileAction = {
  version: 2
  action: ProfileActionIntent
  target: string
  returnPath: string
  createdAt: number
  initiatingUserId: string | null
}

function browserPath(): string | null {
  if (typeof window === 'undefined') return null
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function withActionIntent(returnPath: string, action: ProfileActionIntent): string {
  const url = new URL(returnPath, URL_BASE)
  url.searchParams.set(PROFILE_ACTION_QUERY_PARAM, action)
  return `${url.pathname}${url.search}${url.hash}`
}

function removeActionIntent(returnPath: string): string {
  const url = new URL(returnPath, URL_BASE)
  url.searchParams.delete(PROFILE_ACTION_QUERY_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

function isPendingProfileAction(value: unknown): value is PendingProfileAction {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PendingProfileAction>
  return (
    candidate.version === 2 &&
    typeof candidate.action === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.returnPath === 'string' &&
    typeof candidate.createdAt === 'number' &&
    (candidate.initiatingUserId === null || typeof candidate.initiatingUserId === 'string')
  )
}

function normalizedUserId(userId: string | null | undefined): string | null {
  if (userId == null) return null
  const normalized = userId.trim()
  if (!normalized) {
    throw new Error('Profile action login requires a non-empty user id')
  }
  return normalized
}

function removePendingProof(): boolean {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
    return true
  } catch {
    return false
  }
}

function removeCurrentActionMarker(currentPath: string): void {
  const cleanedPath = removeActionIntent(currentPath)
  try {
    window.history.replaceState(window.history.state, '', cleanedPath)
  } catch {
    // Failing to clean the marker must not authorize an automatic mutation.
  }
}

/**
 * Build a full-page login handoff for a profile action.
 *
 * The pending action is stored in sessionStorage as proof that the user really
 * clicked it. The URL alone never authorizes an automatic follow/watch/message,
 * so a crafted `?resumeAction=` link cannot trigger a mutation.
 */
export function queueProfileActionLogin({
  action,
  target,
  fallbackPath,
  initiatingUserId,
  now = Date.now(),
}: {
  action: ProfileActionIntent
  target: string
  fallbackPath?: string
  initiatingUserId?: string | null
  now?: number
}): string {
  const currentPath = browserPath()
  const safeCurrentPath = safeInternalReturnPath(currentPath)
  const safeFallback = safeInternalReturnPath(fallbackPath)
  if (!safeCurrentPath && !safeFallback) {
    throw new Error('Profile action login requires a safe internal fallback path')
  }

  const returnPath = withActionIntent(safeCurrentPath ?? safeFallback!, action)

  if (typeof window !== 'undefined') {
    const pending: PendingProfileAction = {
      version: 2,
      action,
      target,
      returnPath,
      createdAt: now,
      initiatingUserId: normalizedUserId(initiatingUserId),
    }
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
    } catch {
      // Storage can be disabled. The exact return URL still works, but the
      // action will not auto-resume without the same-tab proof.
    }
  }

  return `/login?returnUrl=${encodeURIComponent(returnPath)}`
}

/**
 * Consume a same-tab pending action after login.
 *
 * Matching requires the action, exact target, exact return path, and a short
 * TTL. An action started by an authenticated-but-expired account is also bound
 * to that account; a truly anonymous action may be completed by the account
 * chosen during login. Once consumed, both proof and marker are removed before
 * the caller mutates.
 */
export function consumeProfileActionLogin({
  actions,
  target,
  currentUserId,
  now = Date.now(),
}: {
  actions: readonly ProfileActionIntent[]
  target: string
  currentUserId?: string | null
  now?: number
}): ProfileActionIntent | null {
  if (typeof window === 'undefined') return null

  let pending: PendingProfileAction
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!isPendingProfileAction(parsed)) {
      if (raw) window.sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    pending = parsed
  } catch {
    return null
  }

  const currentPath = browserPath()
  const actionFromUrl = currentPath
    ? new URL(currentPath, URL_BASE).searchParams.get(PROFILE_ACTION_QUERY_PARAM)
    : null
  const expired = now - pending.createdAt < 0 || now - pending.createdAt > MAX_PENDING_AGE_MS
  const proofMatches =
    !expired &&
    pending.target === target &&
    pending.returnPath === currentPath &&
    pending.action === actionFromUrl &&
    actions.includes(pending.action)
  const actorMatches =
    pending.initiatingUserId === null ||
    pending.initiatingUserId === normalizedUserId(currentUserId)

  if (!proofMatches) {
    if (expired) {
      removePendingProof()
      if (pending.returnPath === currentPath && pending.action === actionFromUrl && currentPath) {
        removeCurrentActionMarker(currentPath)
      }
    }
    return null
  }

  if (!actorMatches) {
    removePendingProof()
    removeCurrentActionMarker(currentPath!)
    return null
  }

  const proofRemoved = removePendingProof()
  removeCurrentActionMarker(currentPath!)
  if (!proofRemoved) return null

  return pending.action
}

export function profileUserTarget(userId: string): string {
  return `user:${userId}`
}

export function profileTraderTarget(source: string, traderId: string): string {
  return `trader:${source.toLowerCase()}:${traderId}`
}
