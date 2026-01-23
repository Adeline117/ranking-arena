/**
 * Unified profile navigation utility.
 * Determines the correct profile URL for any user/trader,
 * and provides a safe navigation function that prevents
 * navigating to invalid or self-referencing profiles.
 */

export type ProfileTarget = {
  id: string
  handle?: string | null
  trader_key?: string | null
  platform?: string | null
}

/**
 * Get the profile URL for a given user/trader target.
 * Priority:
 * 1. If trader_key + platform exist → /trader/{handle_or_key} (trader page)
 * 2. If handle exists → /u/{handle} (user page)
 * 3. If only id exists → /u/{id} (user page, resolves by UUID)
 * 4. Returns null if no valid target
 */
export function getProfileUrl(target: ProfileTarget | null | undefined): string | null {
  if (!target || !target.id) return null

  // Use handle for user profile, fall back to full user ID
  const userHandle = target.handle || target.id
  return `/u/${encodeURIComponent(userHandle)}`
}

/**
 * Validates that a navigation target is not the current user.
 * Returns true if navigation is safe (target is someone else).
 */
export function isValidNavigationTarget(
  target: ProfileTarget | null | undefined,
  currentUserId: string | null | undefined
): boolean {
  if (!target || !target.id) return false
  if (!currentUserId) return false
  return target.id !== currentUserId
}

/**
 * Safe navigation handler for profile clicks.
 * Returns the URL to navigate to, or null if navigation should be blocked.
 *
 * @param target - The user/trader to navigate to
 * @param currentUserId - The current logged-in user's ID
 * @param onError - Callback when navigation is blocked (missing data or self-navigation)
 */
export function getSafeProfileUrl(
  target: ProfileTarget | null | undefined,
  currentUserId: string | null | undefined,
  onError?: (reason: 'missing_data' | 'self_navigation') => void
): string | null {
  if (!target || !target.id) {
    onError?.('missing_data')
    return null
  }

  if (target.id === currentUserId) {
    onError?.('self_navigation')
    return null
  }

  return getProfileUrl(target)
}
