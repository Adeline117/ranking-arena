import { NextRequest, NextResponse } from 'next/server'
import { getGroupRole, canManageMembers } from '@/lib/services/group-permissions'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string; userId: string }> }

// Ban a user from the group
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId, userId: targetUserId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // Check actor's role
    const actorRole = await getGroupRole(supabase, user.id, groupId)
    if (!canManageMembers(actorRole)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Check target's role - cannot ban the owner
    const targetRole = await getGroupRole(supabase, targetUserId, groupId)
    if (targetRole === 'owner') {
      return NextResponse.json({ error: 'Cannot ban the group owner' }, { status: 403 })
    }

    // Admin cannot ban other admins
    if (actorRole === 'admin' && targetRole === 'admin') {
      return NextResponse.json({ error: 'Admins cannot ban other admins' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const reason = (body as { reason?: string }).reason || null

    // Insert into group_bans table
    const { error: banError } = await supabase
      .from('group_bans')
      .insert({
        group_id: groupId,
        user_id: targetUserId,
        banned_by: user.id,
        reason,
      })

    if (banError) {
      logger.error('Ban insert error:', banError)
      return NextResponse.json({ error: 'Ban failed' }, { status: 500 })
    }

    // Remove from group_members
    if (targetRole) {
      const { error: deleteError } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)

      if (deleteError) {
        logger.error('Soft delete member error:', deleteError)
      }

      // Decrement member count
      const { error: decrementError } = await supabase.rpc('increment_member_count', {
        p_group_id: groupId,
        p_delta: -1,
      })

      if (decrementError) {
        // Fallback: read-then-write if RPC not available
        const { data: groupData } = await supabase
          .from('groups')
          .select('member_count')
          .eq('id', groupId)
          .single()

        if (groupData) {
          await supabase
            .from('groups')
            .update({ member_count: Math.max(0, (groupData.member_count || 1) - 1) })
            .eq('id', groupId)
        }
      }
    }

    // Log to group_audit_log (fire-and-forget)
    fireAndForget(
      supabase.from('group_audit_log').insert({
        group_id: groupId,
        actor_id: user.id,
        action: 'ban',
        target_id: targetUserId,
        details: { reason }
      }).then(),
      'Group audit log: ban'
    )

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('Ban user error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// Unban a user from the group
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId, userId: targetUserId } = await context.params

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // Check actor's role
    const actorRole = await getGroupRole(supabase, user.id, groupId)
    if (!canManageMembers(actorRole)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Remove from group_bans
    const { error: unbanError } = await supabase
      .from('group_bans')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (unbanError) {
      logger.error('Unban error:', unbanError)
      return NextResponse.json({ error: 'Failed to unban' }, { status: 500 })
    }

    // Log to group_audit_log (fire-and-forget)
    fireAndForget(
      supabase.from('group_audit_log').insert({
        group_id: groupId,
        actor_id: user.id,
        action: 'unban',
        target_id: targetUserId,
        details: {}
      }).then(),
      'Group audit log: unban'
    )

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    logger.error('Unban user error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
