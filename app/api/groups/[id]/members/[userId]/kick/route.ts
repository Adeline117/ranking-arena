import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
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
      const { data: requesterMembership, error: requesterError } = await supabase
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (requesterError) {
        logger.error('Requester membership lookup failed:', requesterError)
        return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
      }

      if (
        !requesterMembership ||
        (requesterMembership.role !== 'owner' && requesterMembership.role !== 'admin')
      ) {
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      }

      // Check target's role
      const { data: targetMembership, error: targetError } = await supabase
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)
        .maybeSingle()

      if (targetError) {
        logger.error('Target membership lookup failed:', targetError)
        return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
      }

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
      const { data: deleted, error: deleteError } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', targetUserId)
        .select('user_id')

      if (deleteError) {
        logger.error('Kick member error:', deleteError)
        return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
      }

      if (!deleted || deleted.length === 0) {
        return NextResponse.json({ error: 'User is no longer a group member' }, { status: 409 })
      }

      // Send notification to kicked user
      sendNotification(
        supabase,
        {
          user_id: targetUserId,
          type: 'group_update',
          title: 'You have been removed from the group',
          message: 'You have been removed from the group by admin',
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        },
        'Kick notification'
      )

      // Audit log (fire-and-forget)
      fireAndForget(
        supabase
          .from('group_audit_log')
          .insert({
            group_id: groupId,
            actor_id: user.id,
            action: 'kick',
            target_id: targetUserId,
            details: { reason: null },
          })
          .then(),
        'Group audit log: kick'
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-kick', rateLimit: 'sensitive' }
  )

  return handler(request)
}
