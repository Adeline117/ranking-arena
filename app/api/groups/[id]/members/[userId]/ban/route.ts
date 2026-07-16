import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
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
}

function readModerationResult(value: unknown): ModerationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = (value as { status?: unknown }).status
  return typeof status === 'string' ? { status } : null
}

async function moderate(
  actorId: string,
  groupId: string,
  targetUserId: string,
  action: 'ban' | 'unban',
  reason: string | null
): Promise<ModerationResult | null> {
  const { data, error } = await getSupabaseAdmin().rpc(
    'moderate_group_member_atomic' as never,
    {
      p_actor_id: actorId,
      p_group_id: groupId,
      p_target_id: targetUserId,
      p_action: action,
      p_reason: reason,
    } as never
  )

  if (error) {
    logger.error(`Atomic group ${action} failed:`, error)
    return null
  }

  const result = readModerationResult(data)
  if (!result) {
    logger.error(`Atomic group ${action} returned an invalid result`, { data })
  }
  return result
}

function banResponse(result: ModerationResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Ban failed' }, { status: 500 })
  }

  switch (result.status) {
    case 'banned':
      return NextResponse.json({ success: true })
    case 'already_banned':
      return NextResponse.json({ success: true, already_banned: true })
    case 'invalid_reason':
      return NextResponse.json({ error: 'Reason must be at most 500 characters' }, { status: 400 })
    case 'invalid':
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    case 'self_forbidden':
      return NextResponse.json({ error: 'Cannot ban yourself' }, { status: 400 })
    case 'target_not_found':
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'owner_forbidden':
      return NextResponse.json({ error: 'Cannot ban the group owner' }, { status: 403 })
    case 'hierarchy_forbidden':
      return NextResponse.json({ error: 'Admins cannot ban other admins' }, { status: 403 })
    case 'account_inactive':
    case 'forbidden':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    default:
      logger.error('Atomic group ban returned an unknown status', { status: result.status })
      return NextResponse.json({ error: 'Ban failed' }, { status: 500 })
  }
}

function unbanResponse(result: ModerationResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Failed to unban' }, { status: 500 })
  }

  switch (result.status) {
    case 'unbanned':
      return NextResponse.json({ success: true })
    case 'already_unbanned':
      return NextResponse.json({ success: true, already_unbanned: true })
    case 'invalid':
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'Group has been dissolved' }, { status: 409 })
    case 'account_inactive':
    case 'forbidden':
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    default:
      logger.error('Atomic group unban returned an unknown status', { status: result.status })
      return NextResponse.json({ error: 'Failed to unban' }, { status: 500 })
  }
}

// Ban a user from the group. Authorization, member removal, ban insertion and
// audit logging are committed by one service-only database RPC.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user, request: req }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!ModerationIdsSchema.safeParse({ groupId, targetUserId }).success) {
        return NextResponse.json({ error: 'Invalid group or user ID' }, { status: 400 })
      }

      const body: unknown = await req.json().catch(() => ({}))
      const suppliedReason =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as { reason?: unknown }).reason
          : undefined
      if (suppliedReason != null && typeof suppliedReason !== 'string') {
        return NextResponse.json({ error: 'Reason must be a string' }, { status: 400 })
      }

      const reason = suppliedReason || null
      return banResponse(await moderate(user.id, groupId, targetUserId, 'ban', reason))
    },
    { name: 'group-member-ban', rateLimit: 'sensitive' }
  )

  return handler(request)
}

// Unban is idempotent at the HTTP boundary. Only a real unban writes audit
// evidence; already_unbanned returns success without inventing another event.
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { id: groupId, userId: targetUserId } = await context.params

  const handler = withAuth(
    async ({ user }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      if (!ModerationIdsSchema.safeParse({ groupId, targetUserId }).success) {
        return NextResponse.json({ error: 'Invalid group or user ID' }, { status: 400 })
      }

      return unbanResponse(await moderate(user.id, groupId, targetUserId, 'unban', null))
    },
    { name: 'group-member-unban', rateLimit: 'sensitive' }
  )

  return handler(request)
}
