export interface ProfileSuspensionState {
  banned_at?: string | null
  deleted_at?: string | null
  is_banned?: boolean | null
  ban_expires_at?: string | null
}

export function isProfileBanned(profile: ProfileSuspensionState, nowMs = Date.now()): boolean {
  if (profile.banned_at) return true
  if (profile.is_banned !== true) return false
  if (profile.ban_expires_at === null || profile.ban_expires_at === undefined) return true

  const expiresAt = Date.parse(profile.ban_expires_at)
  return !Number.isFinite(expiresAt) || expiresAt > nowMs
}

/**
 * Apply every account-lifecycle suspension marker used by current and legacy
 * profiles. Malformed legacy expiry timestamps fail closed while the flag is
 * set; an expired flag is inactive only when no persistent marker remains.
 */
export function isProfileSuspended(profile: ProfileSuspensionState, nowMs = Date.now()): boolean {
  return Boolean(profile.deleted_at) || isProfileBanned(profile, nowMs)
}
