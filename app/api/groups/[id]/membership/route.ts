import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { sendNotification } from '@/lib/data/notifications'
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

    if (groupErr) {
      logger.error('Group membership lookup failed:', groupErr)
      return NextResponse.json({ error: 'Failed to load group' }, { status: 500 })
    }
    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }

    // Dissolved groups are frozen — no join/leave allowed
    if (group.dissolved_at) {
      return NextResponse.json({ error: 'This group has been dissolved' }, { status: 403 })
    }

    if (action === 'join') {
      // Check if user is banned from this group
      const { data: ban, error: banError } = await sb
        .from('group_bans')
        .select('user_id') // group_bans 无 id(复合主键)——旧 select('id') 400→封禁检查永远失效
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (banError) {
        logger.error('Group ban lookup failed:', banError)
        return NextResponse.json({ error: 'Failed to verify group access' }, { status: 500 })
      }
      if (ban) {
        return NextResponse.json(
          { error: 'You are banned from this group', code: 'BANNED' },
          { status: 403 }
        )
      }

      // Check score gate and verified-only restrictions
      if (group.min_arena_score > 0 || group.is_verified_only) {
        const { data: profile, error: profileError } = await sb
          .from('user_profiles')
          .select('reputation_score, is_verified_trader')
          .eq('id', user.id)
          .maybeSingle()

        if (profileError) {
          logger.error('Group eligibility profile lookup failed:', profileError)
          return NextResponse.json({ error: 'Failed to verify group eligibility' }, { status: 500 })
        }

        if (group.is_verified_only && !profile?.is_verified_trader) {
          return NextResponse.json(
            {
              error: 'This group is restricted to verified traders only',
              code: 'VERIFIED_ONLY',
            },
            { status: 403 }
          )
        }

        if (group.min_arena_score > 0 && (profile?.reputation_score ?? 0) < group.min_arena_score) {
          return NextResponse.json(
            {
              error: `This group requires Arena Score of ${group.min_arena_score}+`,
              code: 'SCORE_TOO_LOW',
              required_score: group.min_arena_score,
            },
            { status: 403 }
          )
        }
      }

      // Check if already a member
      const { data: existing, error: existingError } = await sb
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingError) {
        logger.error('Existing group membership lookup failed:', existingError)
        return NextResponse.json({ error: 'Failed to verify membership' }, { status: 500 })
      }

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

      if (group.created_by && group.created_by !== user.id) {
        sendNotification(
          sb,
          {
            user_id: group.created_by,
            type: 'group_update',
            title: 'New member joined',
            message: 'A new member has joined your group',
            link: `/groups/${groupId}`,
            actor_id: user.id,
            reference_id: groupId,
          },
          'Group join notification'
        )
      }

      return NextResponse.json({ success: true, action: 'joined' })
    }

    if (action === 'leave') {
      // Cannot leave if owner
      if (group.created_by === user.id) {
        return NextResponse.json({ error: 'Owner cannot leave the group' }, { status: 403 })
      }

      const { data: deleted, error: deleteErr } = await sb
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .select('user_id')

      if (deleteErr) {
        logger.error('Leave group error:', deleteErr)
        return NextResponse.json({ error: 'Failed to leave' }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        action: deleted && deleted.length > 0 ? 'left' : 'not_member',
      })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  },
  { name: 'groups/membership', rateLimit: 'write' }
)
