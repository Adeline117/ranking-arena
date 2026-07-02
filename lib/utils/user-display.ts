/**
 * Unified social-user display-name resolution.
 *
 * Before this, every post surface hand-rolled its own fallback and they all
 * disagreed: AvatarLink hid the whole avatar on a null handle; hot PostCard
 * printed `@{author}` (the display name, not the handle) and never handled
 * deleted users; MasonryPostCard/group used `deleted_`-prefix checks; shared
 * PostContent fell back to the literal `'user'`. Net effect: a post by a user
 * with a null/'null'/'deleted_…' handle could render the raw string "null".
 *
 * This is the SINGLE source of truth for "what name do we show for the author
 * of a post/comment". It is NOT for trader/ranking names — those carry wallet
 * truncation + email masking + copin protocol parsing and stay in
 * `app/components/ranking/utils.ts#formatDisplayName`.
 */

// A handle that means "no real user": null/empty, the literal strings a broken
// pipeline writes, or the `deleted_<id>` tombstone handle.
const DELETED_SENTINELS = new Set(['', 'null', 'undefined', 'deleted', 'anonymous'])

export function isDeletedUserHandle(handle?: string | null): boolean {
  if (handle == null) return true
  const h = handle.trim().toLowerCase()
  if (DELETED_SENTINELS.has(h)) return true
  if (h.startsWith('deleted_')) return true
  return false
}

const MAX_NAME_LEN = 24

export function truncateName(name: string, max = MAX_NAME_LEN): string {
  const n = name.trim()
  return n.length > max ? `${n.slice(0, max - 1)}…` : n
}

export interface ResolvedUserName {
  /** Text to render as the author's name (already truncated, never "null"). */
  label: string
  /** True when the author is deleted/unknown — surfaces should not link it. */
  isDeleted: boolean
  /** The handle safe to build a `/u/<handle>` link from, or null if none. */
  linkHandle: string | null
}

/**
 * Resolve the author name to show on a social surface.
 *
 * Priority: real handle → real display name → deletedUser label. Never returns
 * a raw "null"/"undefined"/tombstone string.
 */
export function resolveUserDisplayName(
  input: { handle?: string | null; displayName?: string | null },
  t: (key: string) => string
): ResolvedUserName {
  const handle = input.handle?.trim() ?? ''
  const displayName = input.displayName?.trim() ?? ''

  if (!isDeletedUserHandle(handle)) {
    return { label: truncateName(handle), isDeleted: false, linkHandle: handle }
  }
  // Handle is missing/tombstoned — try the display name before giving up.
  if (displayName && !isDeletedUserHandle(displayName)) {
    return { label: truncateName(displayName), isDeleted: false, linkHandle: null }
  }
  return { label: t('deletedUser'), isDeleted: true, linkHandle: null }
}
