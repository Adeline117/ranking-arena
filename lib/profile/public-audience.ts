import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { getHandleShapeError } from '@/lib/identity/handle-policy'

export const PUBLIC_PROFILE_AUDIENCE_SELECT =
  'id, handle, deleted_at, banned_at, is_banned, ban_expires_at' as const

export type PublicProfileAudienceRow = {
  id: string
  handle: string | null
  deleted_at: string | null
  banned_at: string | null
  is_banned: boolean | null
  ban_expires_at: string | null
}

export type PublicProfileAudience =
  | { status: 'missing'; profile: null }
  | { status: 'inactive'; profile: PublicProfileAudienceRow }
  | { status: 'active'; profile: PublicProfileAudienceRow }

export class PublicProfileAudienceReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PublicProfileAudienceReadError'
  }
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function parseAudienceRow(value: unknown): PublicProfileAudienceRow {
  if (!value || typeof value !== 'object') {
    throw new PublicProfileAudienceReadError('Invalid public profile audience row')
  }

  const row = value as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    (row.handle !== null && typeof row.handle !== 'string') ||
    !isNullableTimestamp(row.deleted_at) ||
    !isNullableTimestamp(row.banned_at) ||
    (row.is_banned !== null && typeof row.is_banned !== 'boolean') ||
    !isNullableTimestamp(row.ban_expires_at)
  ) {
    throw new PublicProfileAudienceReadError('Malformed public profile audience row')
  }

  return row as PublicProfileAudienceRow
}

/**
 * Public profile state is evaluated at request time. Service-role callers must
 * use this boundary before returning profile-owned data because service_role
 * bypasses row-level policies.
 */
export function isPublicProfileActive(
  profile: PublicProfileAudienceRow,
  now = Date.now()
): boolean {
  if (!Number.isFinite(now)) return false
  if (profile.deleted_at !== null || profile.banned_at !== null) return false
  if (profile.is_banned !== true) return true
  if (profile.ban_expires_at === null) return false

  const expiresAt = Date.parse(profile.ban_expires_at)
  return Number.isFinite(expiresAt) && expiresAt <= now
}

export async function readPublicProfileAudienceByHandle(
  supabase: SupabaseClient<Database>,
  handle: string,
  now = Date.now()
): Promise<PublicProfileAudience> {
  // Do not let an invalid URL segment be normalized into a different account.
  // Dots remain readable for unchanged legacy handles; new writes reject them.
  if (getHandleShapeError(handle, { allowUnchangedLegacyDot: true }) !== null) {
    return { status: 'missing', profile: null }
  }

  const exactCaseInsensitivePattern = handle.replace(/[\\%_]/g, (character) => `\\${character}`)
  let result: { data: unknown; error: unknown }
  try {
    result = await supabase
      .from('user_profiles')
      .select(PUBLIC_PROFILE_AUDIENCE_SELECT)
      .ilike('handle', exactCaseInsensitivePattern)
      .limit(2)
  } catch (error) {
    throw new PublicProfileAudienceReadError('Public profile audience read failed', {
      cause: error,
    })
  }

  if (result.error) {
    throw new PublicProfileAudienceReadError('Public profile audience read failed', {
      cause: result.error,
    })
  }
  if (!Array.isArray(result.data)) {
    throw new PublicProfileAudienceReadError('Invalid public profile audience result')
  }
  if (result.data.length === 0) return { status: 'missing', profile: null }
  if (result.data.length !== 1) {
    throw new PublicProfileAudienceReadError('Ambiguous public profile handle')
  }

  const profile = parseAudienceRow(result.data[0])
  return isPublicProfileActive(profile, now)
    ? { status: 'active', profile }
    : { status: 'inactive', profile }
}
