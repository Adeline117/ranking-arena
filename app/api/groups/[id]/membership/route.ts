import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'

/** Extract group id from URL path */
function extractGroupId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('groups')
  return pathParts[idx + 1]
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = extractGroupId(request.url)
    const sb = supabase as SupabaseClient

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { action } = body as { action: 'join' | 'leave' }

    if (!action || !['join', 'leave'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // Verify group exists
    const { data: group, error: groupErr } = await sb
      .from('groups')
      .select('id, created_by, is_premium_only, min_arena_score, is_verified_only, dissolved_at')
      .eq('id', groupId)
      .maybeSingle()

    if (groupErr || !group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    // Dissolved groups are frozen — no join/leave allowed
    if (group.dissolved_at) {
      return NextResponse.json({ error: 'This group has been dissolved' }, { status: 403 })
    }

    if (action === 'join') {
      // Check score gate and verified-only restrictions
      if (group.min_arena_score > 0 || group.is_verified_only) {
        const { data: profile } = await sb
          .from('user_profiles')
          .select('reputation_score, is_verified_trader')
          .eq('id', user.id)
          .maybeSingle()

        if (group.is_verified_only && !profile?.is_verified_trader) {
          return NextResponse.json({
            error: 'This group is restricted to verified traders only',
            code: 'VERIFIED_ONLY',
          }, { status: 403 })
        }

        if (group.min_arena_score > 0 && (profile?.reputation_score ?? 0) < group.min_arena_score) {
          return NextResponse.json({
            error: `This group requires Arena Score of ${group.min_arena_score}+`,
            code: 'SCORE_TOO_LOW',
            required_score: group.min_arena_score,
          }, { status: 403 })
        }
      }

      // Check if already a member
      const { data: existing } = await sb
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existing) {
        return NextResponse.json({ error: 'Already a member' }, { status: 409 })
      }

      const { error: insertErr } = await sb
        .from('group_members')
        .insert({ group_id: groupId, user_id: user.id, role: 'member' })

      if (insertErr) {
        logger.error('Join group error:', insertErr)
        return NextResponse.json({ error: 'Failed to join' }, { status: 500 })
      }

      // Increment count + notify owner (fire-and-forget, don't block response)
      sb.rpc('increment_member_count', { p_group_id: groupId, p_delta: 1 })
        .then(({ error: rpcErr }) => {
          if (rpcErr) logger.error('increment_member_count failed:', rpcErr)
        })

      if (group.created_by && group.created_by !== user.id) {
        sb.from('notifications').insert({
          user_id: group.created_by,
          type: 'system',
          title: 'New member joined',
          message: 'A new member has joined your group',
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        }).then(({ error: notifErr }) => {
          if (notifErr) logger.warn('Join notification failed:', notifErr)
        })
      }

      return NextResponse.json({ success: true, action: 'joined' })
    }

    if (action === 'leave') {
      // Cannot leave if owner
      if (group.created_by === user.id) {
        return NextResponse.json({ error: 'Owner cannot leave the group' }, { status: 403 })
      }

      const { error: deleteErr } = await sb
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', user.id)

      if (deleteErr) {
        logger.error('Leave group error:', deleteErr)
        return NextResponse.json({ error: 'Failed to leave' }, { status: 500 })
      }

      // Decrement count (fire-and-forget)
      sb.rpc('increment_member_count', { p_group_id: groupId, p_delta: -1 })
        .then(({ error: rpcErr }) => {
          if (rpcErr) logger.error('decrement_member_count failed:', rpcErr)
        })

      return NextResponse.json({ success: true, action: 'left' })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  },
  { name: 'groups/membership', rateLimit: 'write' }
)
