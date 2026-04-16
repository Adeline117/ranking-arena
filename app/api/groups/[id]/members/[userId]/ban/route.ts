import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { getGroupRole, canManageMembers } from '@/lib/services/group-permissions'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string; userId: string }> }

// Ban a user from the group
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

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

      const body = await req.json().catch(() => ({}))
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
          // Rollback ban to avoid inconsistent state (banned + still member)
          await supabase.from('group_bans').delete().eq('group_id', groupId).eq('user_id', targetUserId)
          return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
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
          details: { reason },
        }).then(),
        'Group audit log: ban'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-ban', rateLimit: 'sensitive' }
  )

  return handler(request)
}

// Unban a user from the group
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user, supabase }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

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
          details: {},
        }).then(),
        'Group audit log: unban'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-unban', rateLimit: 'sensitive' }
  )

  return handler(request)
}
