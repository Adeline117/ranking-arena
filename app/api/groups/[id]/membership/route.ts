import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { hashInviteToken, verifyInviteToken } from '@/lib/groups/invite-tokens'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PRO_FREE_PROMO } from '@/lib/types/premium'

const UuidSchema = z.string().uuid()
const MembershipBodySchema = z
  .object({
    action: z.enum(['join', 'leave']),
    invite_token: z.string().min(1).max(512).optional(),
    answer_text: z.string().max(2000).optional(),
  })
  .strict()

type AtomicMembershipResult = {
  status: string
  owner_id?: string
  member_count?: number
  role?: string
  request_id?: string
  required_score?: number
}

function readGroupId(url: string): string | null {
  try {
    const pathParts = new URL(url).pathname.split('/')
    const groupsIndex = pathParts.indexOf('groups')
    const parsed = UuidSchema.safeParse(pathParts[groupsIndex + 1])
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function readAtomicResult(value: unknown): AtomicMembershipResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (typeof result.status !== 'string') return null

  return {
    status: result.status,
    ...(typeof result.owner_id === 'string' ? { owner_id: result.owner_id } : {}),
    ...(typeof result.member_count === 'number' ? { member_count: result.member_count } : {}),
    ...(typeof result.role === 'string' ? { role: result.role } : {}),
    ...(typeof result.request_id === 'string' ? { request_id: result.request_id } : {}),
    ...(typeof result.required_score === 'number' ? { required_score: result.required_score } : {}),
  }
}

function failedRpc(operation: string, error: unknown) {
  logger.error(`Atomic group ${operation} failed:`, error)
  return NextResponse.json({ error: 'Group membership operation failed' }, { status: 500 })
}

function commonFailureResponse(result: AtomicMembershipResult | null) {
  if (!result) {
    return NextResponse.json({ error: 'Group membership operation failed' }, { status: 500 })
  }

  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid membership request' }, { status: 400 })
    case 'invalid_invite':
      return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
    case 'invite_already_used':
      return NextResponse.json(
        { error: 'This invite has already been used by this account', code: 'INVITE_ALREADY_USED' },
        { status: 409 }
      )
    case 'invalid_answer':
      return NextResponse.json(
        { error: 'Join answer must be at most 2000 characters' },
        { status: 400 }
      )
    case 'account_inactive':
      return NextResponse.json({ error: 'Account is not active' }, { status: 403 })
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json({ error: 'This group has been dissolved' }, { status: 409 })
    case 'banned':
      return NextResponse.json(
        { error: 'You are banned from this group', code: 'BANNED' },
        { status: 403 }
      )
    case 'score_too_low':
      return NextResponse.json(
        {
          error: `This group requires Arena Score of ${result.required_score ?? 0}+`,
          code: 'SCORE_TOO_LOW',
          required_score: result.required_score ?? 0,
        },
        { status: 403 }
      )
    case 'verified_only':
      return NextResponse.json(
        {
          error: 'This group is restricted to verified traders only',
          code: 'VERIFIED_ONLY',
        },
        { status: 403 }
      )
    case 'premium_required':
      return NextResponse.json(
        { error: 'Pro membership is required', code: 'PREMIUM_REQUIRED' },
        { status: 403 }
      )
    case 'invite_required':
      return NextResponse.json(
        { error: 'An invite is required to join this group', code: 'INVITE_REQUIRED' },
        { status: 403 }
      )
    case 'approval_required':
      return NextResponse.json(
        { error: 'This group requires approval', code: 'APPROVAL_REQUIRED' },
        { status: 409 }
      )
    case 'owner_forbidden':
      return NextResponse.json({ error: 'Owner cannot leave the group' }, { status: 403 })
    default:
      logger.error('Atomic group membership returned an unknown status', {
        status: result.status,
      })
      return NextResponse.json({ error: 'Group membership operation failed' }, { status: 500 })
  }
}

function notifyOwnerAfterJoin(
  admin: ReturnType<typeof getSupabaseAdmin>,
  result: AtomicMembershipResult,
  actorId: string,
  groupId: string
) {
  const owner = UuidSchema.safeParse(result.owner_id)
  if (!owner.success) {
    logger.error('Atomic group join omitted a valid owner ID', { owner_id: result.owner_id })
    return
  }
  if (owner.data === actorId) return

  // The membership transaction and audit evidence are already committed. This
  // deduplicated notification is deliberately fire-and-forget afterward.
  sendNotification(
    admin,
    {
      user_id: owner.data,
      type: 'group_update',
      title: 'New member joined',
      message: 'A new member has joined your group',
      link: `/groups/${groupId}`,
      actor_id: actorId,
      reference_id: groupId,
    },
    'Group join notification'
  )
}

function successfulJoinResponse(
  admin: ReturnType<typeof getSupabaseAdmin>,
  result: AtomicMembershipResult,
  actorId: string,
  groupId: string
) {
  if (result.status === 'joined') {
    notifyOwnerAfterJoin(admin, result, actorId, groupId)
    return NextResponse.json({
      success: true,
      action: 'joined',
      ...(typeof result.member_count === 'number' ? { member_count: result.member_count } : {}),
    })
  }

  if (result.status === 'already_member') {
    return NextResponse.json({
      success: true,
      action: 'already_member',
      ...(result.role ? { role: result.role } : {}),
      ...(typeof result.member_count === 'number' ? { member_count: result.member_count } : {}),
    })
  }

  return commonFailureResponse(result)
}

export const POST = withAuth(
  async ({ user, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = readGroupId(request.url)
    if (!groupId) {
      return NextResponse.json({ error: 'Invalid group ID' }, { status: 400 })
    }

    const parsedBody = MembershipBodySchema.safeParse(await request.json().catch(() => null))
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid membership request' }, { status: 400 })
    }

    const { action, answer_text: answerText, invite_token: inviteToken } = parsedBody.data
    if (action === 'leave' && (answerText !== undefined || inviteToken !== undefined)) {
      return NextResponse.json({ error: 'Leave does not accept join fields' }, { status: 400 })
    }

    const admin = getSupabaseAdmin()

    if (action === 'leave') {
      const { data, error } = await admin.rpc(
        'mutate_group_membership_atomic' as never,
        {
          p_actor_id: user.id,
          p_group_id: groupId,
          p_action: 'leave',
          p_pro_free_promo: PRO_FREE_PROMO,
        } as never
      )
      if (error) return failedRpc('leave', error)

      const result = readAtomicResult(data)
      if (!result) {
        logger.error('Atomic group leave returned an invalid result', { data })
        return commonFailureResponse(null)
      }
      if (result.status === 'left') {
        return NextResponse.json({
          success: true,
          action: 'left',
          ...(typeof result.member_count === 'number' ? { member_count: result.member_count } : {}),
        })
      }
      if (result.status === 'not_member') {
        return NextResponse.json({ success: true, action: 'not_member' })
      }
      return commonFailureResponse(result)
    }

    if (inviteToken) {
      const verified = verifyInviteToken(inviteToken)
      if (!verified.valid || verified.groupId !== groupId) {
        return NextResponse.json({ error: 'Invalid or expired invite' }, { status: 400 })
      }

      const { data, error } = await admin.rpc(
        'redeem_group_invite_atomic' as never,
        {
          p_actor_id: user.id,
          p_group_id: groupId,
          p_token_hash: hashInviteToken(inviteToken),
          p_pro_free_promo: PRO_FREE_PROMO,
        } as never
      )
      if (error) return failedRpc('invite redemption', error)

      const result = readAtomicResult(data)
      if (!result) {
        logger.error('Atomic invite redemption returned an invalid result', { data })
        return commonFailureResponse(null)
      }
      return successfulJoinResponse(admin, result, user.id, groupId)
    }

    const join = async () => {
      const { data, error } = await admin.rpc(
        'mutate_group_membership_atomic' as never,
        {
          p_actor_id: user.id,
          p_group_id: groupId,
          p_action: 'join',
          p_pro_free_promo: PRO_FREE_PROMO,
        } as never
      )
      return { result: readAtomicResult(data), error, data }
    }

    const firstJoin = await join()
    if (firstJoin.error) return failedRpc('join', firstJoin.error)
    if (!firstJoin.result) {
      logger.error('Atomic group join returned an invalid result', { data: firstJoin.data })
      return commonFailureResponse(null)
    }
    if (firstJoin.result.status !== 'approval_required') {
      return successfulJoinResponse(admin, firstJoin.result, user.id, groupId)
    }

    const { data: requestData, error: requestError } = await admin.rpc(
      'mutate_group_join_request_atomic' as never,
      {
        p_actor_id: user.id,
        p_group_id: groupId,
        p_action: 'request',
        p_answer_text: answerText ?? null,
        p_pro_free_promo: PRO_FREE_PROMO,
      } as never
    )
    if (requestError) return failedRpc('join request', requestError)

    const requestResult = readAtomicResult(requestData)
    if (!requestResult) {
      logger.error('Atomic join request returned an invalid result', { data: requestData })
      return commonFailureResponse(null)
    }

    if (requestResult.status === 'requested' || requestResult.status === 'already_pending') {
      const requestId = UuidSchema.safeParse(requestResult.request_id)
      if (!requestId.success) {
        logger.error('Atomic join request omitted a valid request ID', {
          request_id: requestResult.request_id,
        })
        return commonFailureResponse(null)
      }
      return NextResponse.json(
        {
          success: true,
          action: 'requested',
          request_id: requestId.data,
          ...(requestResult.status === 'already_pending' ? { already_pending: true } : {}),
        },
        { status: 202 }
      )
    }

    // Visibility or review may change between the two committed RPCs. One
    // bounded retry resolves open-group and already-approved races without a
    // route-owned write or unbounded loop.
    if (requestResult.status === 'open_group' || requestResult.status === 'already_approved') {
      const retriedJoin = await join()
      if (retriedJoin.error) return failedRpc('join retry', retriedJoin.error)
      if (!retriedJoin.result) {
        logger.error('Atomic group join retry returned an invalid result', {
          data: retriedJoin.data,
        })
        return commonFailureResponse(null)
      }
      return successfulJoinResponse(admin, retriedJoin.result, user.id, groupId)
    }

    if (requestResult.status === 'already_member') {
      return NextResponse.json({ success: true, action: 'already_member' })
    }

    return commonFailureResponse(requestResult)
  },
  { name: 'groups/membership', rateLimit: 'write' }
)
