import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import logger from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string; userId: string }> }

const ModerationIdsSchema = z.object({
  groupId: z.string().uuid(),
  targetUserId: z.string().uuid(),
})

type ModerationResult = {
  status: string
  member_count?: number
}

const SIMPLE_KICK_STATUSES = new Set([
  'self_forbidden',
  'invalid',
  'target_not_found',
  'not_member',
  'not_found',
  'dissolved',
  'owner_forbidden',
  'hierarchy_forbidden',
  'account_inactive',
  'forbidden',
])

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readModerationResult(value: unknown): ModerationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const acknowledgement = value as Record<string, unknown>
  const status = acknowledgement.status
  if (status === 'kicked') {
    return hasExactKeys(acknowledgement, ['status', 'member_count']) &&
      isSafeNonNegativeInteger(acknowledgement.member_count)
      ? { status, member_count: acknowledgement.member_count }
      : null
  }
  return typeof status === 'string' &&
    SIMPLE_KICK_STATUSES.has(status) &&
    hasExactKeys(acknowledgement, ['status'])
    ? { status }
    : null
}

function nonSuccessResponse(result: ModerationResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }

  switch (result.status) {
    case 'self_forbidden':
      return NextResponse.json({ error: 'Cannot kick yourself' }, { status: 400 })
    case 'invalid':
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    case 'target_not_found':
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    case 'not_member':
      return NextResponse.json({ error: 'User is no longer a group member' }, { status: 409 })
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'owner_forbidden':
      return NextResponse.json({ error: 'Cannot kick the group owner' }, { status: 403 })
    case 'hierarchy_forbidden':
      return NextResponse.json({ error: 'Admins can only kick regular members' }, { status: 403 })
    case 'account_inactive':
    case 'forbidden':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    default:
      logger.error('Atomic group kick returned an unknown status', { status: result.status })
      return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!ModerationIdsSchema.safeParse({ groupId, targetUserId }).success) {
        return NextResponse.json({ error: 'Invalid group or user ID' }, { status: 400 })
      }

      const admin = getSupabaseAdmin()
      const { data, error } = await admin.rpc('moderate_group_member_atomic', {
        p_actor_id: user.id,
        p_group_id: groupId,
        p_target_id: targetUserId,
        p_action: 'kick',
        p_reason: null,
      })

      if (error) {
        logger.error('Atomic group kick failed:', error)
        return NextResponse.json({ error: 'Operation failed' }, { status: 500 })
      }

      const result = readModerationResult(data)
      if (result?.status !== 'kicked') {
        if (!result) {
          logger.error('Atomic group kick returned an invalid result', { data })
        }
        return nonSuccessResponse(result)
      }

      // External notification is intentionally after the committed RPC. The
      // transactional audit entry is already durable at this point.
      sendNotification(
        admin,
        {
          user_id: targetUserId,
          type: 'group_update',
          title: 'You have been removed from the group',
          message: 'You have been removed from the group by admin',
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: groupId,
        },
        'Kick notification',
        // The atomic RPC reports `kicked` only for the transaction that
        // actually removed the membership. A later rejoin-and-kick is a new
        // moderation event and must not be suppressed by the group ID.
        { deduplicate: false }
      )

      return NextResponse.json({ success: true })
    },
    { name: 'group-member-kick', rateLimit: 'sensitive' }
  )

  return handler(request)
}
