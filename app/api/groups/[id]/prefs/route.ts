import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { logger } from '@/lib/logger'
import { badRequest, notFound, serverError, success as apiSuccess } from '@/lib/api/response'
import { z } from 'zod'

const NO_STORE = 'private, no-store'
const GroupIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const PreferencesRowSchema = z
  .object({
    self_notify_muted: z.boolean(),
    pinned: z.boolean(),
  })
  .strict()
const PatchPreferencesSchema = z.union([
  z.object({ self_notify_muted: z.boolean() }).strict(),
  z.object({ pinned: z.boolean() }).strict(),
])

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE)
  return response
}

/** Extract group id from URL path */
function extractGroupId(url: string): string | null {
  try {
    const pathParts = new URL(url).pathname.split('/')
    const idx = pathParts.indexOf('groups')
    const parsed = GroupIdSchema.safeParse(idx >= 0 ? pathParts[idx + 1] : null)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * GET /api/groups/[id]/prefs
 * Return the authenticated member's OWN per-group preferences
 * ({ self_notify_muted, pinned }). Member-controlled — distinct from the
 * admin moderation columns (notifications_muted/muted_by). Non-members 404.
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return noStore(guard)

    const groupId = extractGroupId(request.url)
    if (!groupId) return noStore(badRequest('Invalid group ID'))

    const { data, error } = await supabase
      .from('group_members')
      .select('self_notify_muted, pinned')
      .eq('group_id', groupId)
      .eq('user_id', user!.id)
      .maybeSingle()

    if (error) {
      logger.error('groups/prefs GET failed:', error)
      return noStore(serverError('Failed to load preferences'))
    }

    if (!data) {
      // Not a member of this group — nothing to configure.
      return noStore(notFound('Not a member of this group'))
    }

    const preferences = PreferencesRowSchema.safeParse(data)
    if (!preferences.success) {
      logger.error('groups/prefs GET returned an invalid preference row')
      return noStore(serverError('Failed to load preferences'))
    }

    return noStore(
      apiSuccess({
        preferences: {
          viewer_id: user.id.toLowerCase(),
          group_id: groupId,
          self_notify_muted: preferences.data.self_notify_muted,
          pinned: preferences.data.pinned,
        },
      })
    )
  },
  { name: 'groups/prefs-get', rateLimit: 'authenticated' }
)

/**
 * PATCH /api/groups/[id]/prefs
 * Update the caller's OWN membership prefs. Body may contain either/both:
 *   { self_notify_muted?: boolean, pinned?: boolean }
 * Scoped to the caller's own row (.eq user_id) — a member can never change
 * another member's prefs. Non-members 404.
 */
export const PATCH = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return noStore(guard)

    const groupId = extractGroupId(request.url)
    if (!groupId) return noStore(badRequest('Invalid group ID'))

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return noStore(badRequest('Invalid JSON body'))
    }

    const parsedBody = PatchPreferencesSchema.safeParse(body)
    if (!parsedBody.success) {
      return noStore(badRequest('Provide exactly one boolean preference'))
    }
    const [field, value] =
      'self_notify_muted' in parsedBody.data
        ? (['self_notify_muted', parsedBody.data.self_notify_muted] as const)
        : (['pinned', parsedBody.data.pinned] as const)
    const patch = { [field]: value }

    // .eq('user_id', user!.id) confines the write to the caller's own row; RLS
    // + this filter together guarantee a member can only mutate their own prefs.
    const { data, error } = await supabase
      .from('group_members')
      .update(patch)
      .eq('group_id', groupId)
      .eq('user_id', user!.id)
      .select('self_notify_muted, pinned')
      .maybeSingle()

    if (error) {
      logger.error('groups/prefs PATCH failed:', error)
      return noStore(serverError('Failed to update preferences'))
    }

    if (!data) {
      return noStore(notFound('Not a member of this group'))
    }

    const preferences = PreferencesRowSchema.safeParse(data)
    if (!preferences.success || preferences.data[field] !== value) {
      logger.error('groups/prefs PATCH returned an invalid acknowledgement')
      return noStore(serverError('Failed to update preferences'))
    }

    return noStore(
      apiSuccess({
        preferences: {
          viewer_id: user.id.toLowerCase(),
          group_id: groupId,
          self_notify_muted: preferences.data.self_notify_muted,
          pinned: preferences.data.pinned,
        },
        mutation: { field, value },
      })
    )
  },
  { name: 'groups/prefs-patch', rateLimit: 'authenticated' }
)
