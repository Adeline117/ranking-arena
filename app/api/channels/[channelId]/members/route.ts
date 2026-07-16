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

type AddMembersAcknowledgement =
  | { success: true; channelId: string; added: number }
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
    const supabase = getSupabaseAdmin()
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .select('type')
      .eq('id', channelId)
      .maybeSingle()
    if (channelError) {
      return NextResponse.json({ error: 'Failed to verify channel' }, { status: 500 })
    }
    if (!channel) return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    if (channel.type !== 'group') {
      return NextResponse.json(
        { error: 'Channel does not support member management' },
        { status: 400 }
      )
    }

    // If removing self = leaving
    if (targetUserId === actorId) {
      // Owner can't leave, must transfer or dissolve
      const { data: mem, error: membershipError } = await supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', actorId)
        .maybeSingle()

      if (membershipError) {
        return NextResponse.json({ error: 'Failed to verify membership' }, { status: 500 })
      }
      if (!mem) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
      if (mem?.role === 'owner') {
        return NextResponse.json(
          { error: 'Owner cannot leave. Please transfer ownership or disband the group first.' },
          { status: 400 }
        )
      }

      const { error: leaveError } = await supabase
        .from('channel_members')
        .delete()
        .eq('channel_id', channelId)
        .eq('user_id', actorId)

      if (leaveError) {
        return NextResponse.json({ error: 'Failed to leave channel' }, { status: 500 })
      }

      return NextResponse.json({ ok: true, action: 'left' })
    }

    // Removing another user - need admin/owner
    const [myMembershipResult, targetMembershipResult] = await Promise.all([
      supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', actorId)
        .maybeSingle(),
      supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', targetUserId)
        .maybeSingle(),
    ])

    if (myMembershipResult.error || targetMembershipResult.error) {
      return NextResponse.json({ error: 'Failed to verify membership' }, { status: 500 })
    }
    const myMembership = myMembershipResult.data
    if (!myMembership || !['owner', 'admin'].includes(myMembership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const targetMem = targetMembershipResult.data
    if (!targetMem) return NextResponse.json({ error: 'Membership not found' }, { status: 404 })

    // Can't remove owner
    if (targetMem?.role === 'owner') {
      return NextResponse.json({ error: 'Cannot remove the group owner' }, { status: 400 })
    }

    // Admin can only remove members, not other admins (unless owner)
    if (myMembership.role === 'admin' && targetMem?.role === 'admin') {
      return NextResponse.json({ error: 'Admins cannot remove other admins' }, { status: 403 })
    }

    const { error: removeError } = await supabase
      .from('channel_members')
      .delete()
      .eq('channel_id', channelId)
      .eq('user_id', targetUserId)

    if (removeError) {
      return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, action: 'removed' })
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
    const supabase = getSupabaseAdmin()

    // Owner only can change roles, and only on an existing group member.
    const [channelResult, myMembershipResult, targetMembershipResult] = await Promise.all([
      supabase.from('chat_channels').select('type').eq('id', channelId).maybeSingle(),
      supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', actorId)
        .maybeSingle(),
      supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', targetUserId)
        .maybeSingle(),
    ])

    if (channelResult.error || myMembershipResult.error || targetMembershipResult.error) {
      return NextResponse.json({ error: 'Failed to verify membership' }, { status: 500 })
    }
    if (!channelResult.data) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }
    if (channelResult.data.type !== 'group') {
      return NextResponse.json(
        { error: 'Channel does not support member management' },
        { status: 400 }
      )
    }
    const myMem = myMembershipResult.data
    if (!myMem || myMem.role !== 'owner') {
      return NextResponse.json({ error: 'Only owner can change roles' }, { status: 403 })
    }
    const targetMem = targetMembershipResult.data
    if (!targetMem) {
      return NextResponse.json({ error: 'Membership not found' }, { status: 404 })
    }

    // Ownership transfer is a separate operation. Never let this generic role
    // endpoint demote any owner, including a self-targeted request.
    if (targetUserId === actorId || targetMem.role === 'owner') {
      return NextResponse.json({ error: 'Owner role cannot be changed here' }, { status: 400 })
    }

    const { data: updatedMember, error: updateError } = await supabase
      .from('channel_members')
      .update({ role })
      .eq('channel_id', channelId)
      .eq('user_id', targetUserId)
      .eq('role', targetMem.role)
      .select('user_id')
      .maybeSingle()

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
    }
    if (!updatedMember) {
      return NextResponse.json({ error: 'Membership changed during request' }, { status: 409 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('UPDATE_MEMBER_ROLE failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
