import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string; userId: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user, supabase }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      // Cannot kick yourself
      if (user.id === targetUserId) {
        return NextResponse.json({ error: 'Cannot kick yourself' }, { status: 400 })
      }

      // Check requester's role
      const { data: requesterMembership } = await supabase
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (!requesterMembership || (requesterMembership.role !== 'owner' && requesterMembership.role !== 'admin')) {
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      }

      // Check target's role
      const { data: targetMembership } = await supabase
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)
        .maybeSingle()

      if (!targetMembership) {
        return NextResponse.json({ error: 'User is not a group member' }, { status: 404 })
      }

      // Owner can kick anyone except self (already checked); admin can only kick members
      if (requesterMembership.role === 'admin' && targetMembership.role !== 'member') {
        return NextResponse.json({ error: 'Admins can only kick regular members' }, { status: 403 })
      }

      // Cannot kick the owner
      if (targetMembership.role === 'owner') {
        return NextResponse.json({ error: 'Cannot kick the group owner' }, { status: 403 })
      }

      // Remove from group_members
      const { error: deleteError } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)

      if (deleteError) {
        logger.error('Kick member error:', deleteError)
        return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
      }

      // Atomically decrement member_count to avoid race conditions
      const { error: decrementError } = await supabase.rpc('increment_member_count', {
        p_group_id: groupId,
        p_delta: -1,
      })

      if (decrementError) {
        // Fallback: read-then-write if RPC not available
        const { data: groupData, error: groupError } = await supabase
          .from('groups')
          .select('member_count')
          .eq('id', groupId)
          .single()

        if (groupError) {
          logger.error('Failed to fetch group for member_count update:', groupError)
        } else if (groupData) {
          await supabase
            .from('groups')
            .update({ member_count: Math.max(0, (groupData.member_count || 1) - 1) })
            .eq('id', groupId)
        }
      }

      // Send notification to kicked user
      const { error: notifyError } = await supabase
        .from('notifications')
        .insert({
          user_id: targetUserId,
          type: 'system',
          title: 'You have been removed from the group',
          message: `You have been removed from the group by admin`,
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        })

      if (notifyError) {
        logger.error('Failed to send kick notification:', notifyError)
      }

      // Audit log (fire-and-forget)
      fireAndForget(
        supabase.from('group_audit_log').insert({
          group_id: groupId,
          actor_id: user.id,
          action: 'kick',
          target_id: targetUserId,
          details: { reason: null },
        }).then(),
        'Group audit log: kick'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-kick', rateLimit: 'sensitive' }
  )

  return handler(request)
}
