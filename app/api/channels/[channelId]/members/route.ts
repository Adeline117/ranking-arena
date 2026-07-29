/**
 * Channel Members API
 * POST: Add members
 * DELETE: Remove a member or leave
 * PATCH: Update member role
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import {
  addChannelMembersInputSchema,
  channelIdSchema,
  removeChannelMemberInputSchema,
  updateChannelMemberRoleInputSchema,
} from '../../contracts'

const logger = createLogger('api:channels:channelId:members')

const addMemberFailureReasons = new Set([
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_GROUP',
  'PERMISSION_DENIED',
  'CAPACITY_EXCEEDED',
  'CANDIDATE_UNAVAILABLE',
  'PRIVACY_DENIED',
])

const memberMutationFailureReasons = new Set([
  'ACTOR_UNAVAILABLE',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_GROUP',
  'MEMBERSHIP_NOT_FOUND',
  'OWNER_FORBIDDEN',
  'PEER_ADMIN_FORBIDDEN',
  'PERMISSION_DENIED',
])

type MemberMutationAction = 'leave' | 'remove' | 'set_role'

type AddMembersAcknowledgement =
  | { success: true; channelId: string; added: number }
  | { success: false; reason: string }

type MemberMutationAcknowledgement =
  | {
      success: true
      channelId: string
      actorId: string
      targetId: string
      action: MemberMutationAction
      changed: boolean
      role: 'admin' | 'member' | null
    }
  | { success: false; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readAddMembersAcknowledgement(value: unknown): AddMembersAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === true) {
    if (!hasExactKeys(result, ['added', 'channel_id', 'success'])) return null
    if (
      typeof result.channel_id !== 'string' ||
      !channelIdSchema.safeParse(result.channel_id).success ||
      !Number.isSafeInteger(result.added) ||
      (result.added as number) < 0
    ) {
      return null
    }
    return {
      success: true,
      channelId: result.channel_id.toLowerCase(),
      added: result.added as number,
    }
  }

  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !addMemberFailureReasons.has(result.reason)) {
      return null
    }
    return { success: false, reason: result.reason }
  }

  return null
}

function readMemberMutationAcknowledgement(value: unknown): MemberMutationAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !memberMutationFailureReasons.has(result.reason)) {
      return null
    }
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !hasExactKeys(result, [
      'action',
      'actor_id',
      'changed',
      'channel_id',
      'role',
      'success',
      'target_id',
    ]) ||
    !['leave', 'remove', 'set_role'].includes(result.action as string) ||
    typeof result.changed !== 'boolean'
  ) {
    return null
  }

  const parsedChannelId = channelIdSchema.safeParse(result.channel_id)
  const parsedActorId = channelIdSchema.safeParse(result.actor_id)
  const parsedTargetId = channelIdSchema.safeParse(result.target_id)
  if (!parsedChannelId.success || !parsedActorId.success || !parsedTargetId.success) {
    return null
  }

  const action = result.action as MemberMutationAction
  if (
    (action === 'set_role' && result.role !== 'admin' && result.role !== 'member') ||
    (action !== 'set_role' && (result.role !== null || result.changed !== true))
  ) {
    return null
  }

  return {
    success: true,
    channelId: parsedChannelId.data,
    actorId: parsedActorId.data,
    targetId: parsedTargetId.data,
    action,
    changed: result.changed,
    role: result.role as 'admin' | 'member' | null,
  }
}

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = addChannelMembersInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid member request' }, { status: 400 })
    }
    const channelId = parsedChannelId.data
    const actorId = user.id.toLowerCase()
    const candidateIds = [...new Set(parsedBody.data.userIds)].filter(
      (candidateId) => candidateId !== actorId
    )
    if (candidateIds.length === 0) {
      return NextResponse.json({ error: 'No users specified' }, { status: 400 })
    }

    const { data, error } = await getSupabaseAdmin().rpc('add_channel_members_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_candidate_ids: candidateIds,
    })

    if (error) {
      logger.error('Atomic channel member addition failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })
    }

    const acknowledgement = readAddMembersAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic channel member addition returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support member management' },
            { status: 400 }
          )
        case 'PERMISSION_DENIED':
          return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
        case 'CAPACITY_EXCEEDED':
          return NextResponse.json({ error: 'Group chat max 50 members' }, { status: 400 })
        case 'CANDIDATE_UNAVAILABLE':
        case 'PRIVACY_DENIED':
          return NextResponse.json(
            { error: 'One or more selected users cannot be added' },
            { status: 400 }
          )
        default:
          logger.error('Atomic channel member addition returned an unknown denial')
          return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })
      }
    }

    if (acknowledgement.channelId !== channelId || acknowledgement.added > candidateIds.length) {
      logger.error('Atomic channel member addition acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, added: acknowledgement.added })
  } catch (error) {
    logger.error('ADD_MEMBERS failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = removeChannelMemberInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid member request' }, { status: 400 })
    }
    const channelId = parsedChannelId.data
    const targetUserId = parsedBody.data.userId
    const actorId = user.id.toLowerCase()
    const action: MemberMutationAction = targetUserId === actorId ? 'leave' : 'remove'
    const { data, error } = await getSupabaseAdmin().rpc('mutate_channel_member_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_target_id: targetUserId,
      p_action: action,
      p_role: null,
    })

    if (error) {
      logger.error('Atomic channel member removal failed', { error: error.message })
      return NextResponse.json(
        { error: action === 'leave' ? 'Failed to leave channel' : 'Failed to remove member' },
        { status: 500 }
      )
    }

    const acknowledgement = readMemberMutationAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic channel member removal returned an invalid acknowledgement')
      return NextResponse.json(
        { error: action === 'leave' ? 'Failed to leave channel' : 'Failed to remove member' },
        { status: 500 }
      )
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support member management' },
            { status: 400 }
          )
        case 'MEMBERSHIP_NOT_FOUND':
          return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
        case 'OWNER_FORBIDDEN':
          return NextResponse.json(
            {
              error:
                action === 'leave'
                  ? 'Owner cannot leave. Please transfer ownership or disband the group first.'
                  : 'Cannot remove the group owner',
            },
            { status: 400 }
          )
        case 'PEER_ADMIN_FORBIDDEN':
          return NextResponse.json({ error: 'Admins cannot remove other admins' }, { status: 403 })
        case 'ACTOR_UNAVAILABLE':
        case 'PERMISSION_DENIED':
          return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
        default:
          logger.error('Atomic channel member removal returned an unknown denial')
          return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
      }
    }

    if (
      acknowledgement.channelId !== channelId ||
      acknowledgement.actorId !== actorId ||
      acknowledgement.targetId !== targetUserId ||
      acknowledgement.action !== action ||
      acknowledgement.role !== null ||
      !acknowledgement.changed
    ) {
      logger.error('Atomic channel member removal acknowledgement did not match its request')
      return NextResponse.json(
        { error: action === 'leave' ? 'Failed to leave channel' : 'Failed to remove member' },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true, action: action === 'leave' ? 'left' : 'removed' })
  } catch (error) {
    logger.error('REMOVE_MEMBER failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = updateChannelMemberRoleInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid role request' }, { status: 400 })
    }
    const channelId = parsedChannelId.data
    const { userId: targetUserId, role } = parsedBody.data
    const actorId = user.id.toLowerCase()
    // Self-targeting would be a disguised owner demotion. Reject it before the
    // database boundary so the action contract stays unambiguous.
    if (targetUserId === actorId) {
      return NextResponse.json({ error: 'Owner role cannot be changed here' }, { status: 400 })
    }

    const { data, error } = await getSupabaseAdmin().rpc('mutate_channel_member_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_target_id: targetUserId,
      p_action: 'set_role',
      p_role: role,
    })

    if (error) {
      logger.error('Atomic channel member role change failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
    }

    const acknowledgement = readMemberMutationAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic channel member role change returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support member management' },
            { status: 400 }
          )
        case 'MEMBERSHIP_NOT_FOUND':
          return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
        case 'OWNER_FORBIDDEN':
          return NextResponse.json({ error: 'Owner role cannot be changed here' }, { status: 400 })
        case 'ACTOR_UNAVAILABLE':
        case 'PEER_ADMIN_FORBIDDEN':
        case 'PERMISSION_DENIED':
          return NextResponse.json({ error: 'Only owner can change roles' }, { status: 403 })
        default:
          logger.error('Atomic channel member role change returned an unknown denial')
          return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
      }
    }

    if (
      acknowledgement.channelId !== channelId ||
      acknowledgement.actorId !== actorId ||
      acknowledgement.targetId !== targetUserId ||
      acknowledgement.action !== 'set_role' ||
      acknowledgement.role !== role
    ) {
      logger.error('Atomic channel member role acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('UPDATE_MEMBER_ROLE failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
