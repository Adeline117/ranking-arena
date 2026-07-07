import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { logger } from '@/lib/logger'

/** Extract group id from URL path */
function extractGroupId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('groups')
  return pathParts[idx + 1]
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
    if (guard) return guard

    const groupId = extractGroupId(request.url)

    const { data, error } = await supabase
      .from('group_members')
      .select('self_notify_muted, pinned')
      .eq('group_id', groupId)
      .eq('user_id', user!.id)
      .maybeSingle()

    if (error) {
      logger.error('groups/prefs GET failed:', error)
      return NextResponse.json({ error: 'Failed to load preferences' }, { status: 500 })
    }

    if (!data) {
      // Not a member of this group — nothing to configure.
      return NextResponse.json({ error: 'Not a member of this group' }, { status: 404 })
    }

    const res = NextResponse.json({
      data: {
        self_notify_muted: !!data.self_notify_muted,
        pinned: !!data.pinned,
      },
    })
    res.headers.set('Cache-Control', 'private, no-store')
    return res
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
    if (guard) return guard

    const groupId = extractGroupId(request.url)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const patch: { self_notify_muted?: boolean; pinned?: boolean } = {}
    if (typeof body.self_notify_muted === 'boolean') {
      patch.self_notify_muted = body.self_notify_muted
    }
    if (typeof body.pinned === 'boolean') {
      patch.pinned = body.pinned
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Provide self_notify_muted and/or pinned (boolean)' },
        { status: 400 }
      )
    }

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
      return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: 'Not a member of this group' }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: {
        self_notify_muted: !!data.self_notify_muted,
        pinned: !!data.pinned,
      },
    })
  },
  { name: 'groups/prefs-patch', rateLimit: 'authenticated' }
)
