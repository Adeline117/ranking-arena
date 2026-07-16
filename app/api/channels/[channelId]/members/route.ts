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
import { filterChannelAddableUsers } from '@/lib/data/channel-permissions'
import {
  addChannelMembersInputSchema,
  channelIdSchema,
  removeChannelMemberInputSchema,
  updateChannelMemberRoleInputSchema,
} from '../../contracts'

const logger = createLogger('api:channels:channelId:members')

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

    const supabase = getSupabaseAdmin()

    // Check both the actor's authority and that this is actually a group
    // channel. Direct-message channel membership is not managed here.
    const [membershipResult, channelResult] = await Promise.all([
      supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', actorId)
        .maybeSingle(),
      supabase.from('chat_channels').select('type').eq('id', channelId).maybeSingle(),
    ])

    if (membershipResult.error || channelResult.error) {
      return NextResponse.json({ error: 'Failed to verify channel permission' }, { status: 500 })
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
    const membership = membershipResult.data
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Read the complete current roster. Existing candidates must never be
    // upserted with role='member' because that would silently demote an owner
    // or admin, and new candidates must be checked against every co-member's
    // block relationship before any write.
    // KEEP 'exact' — 50 member cap enforcement. Scoped per-channel via
    // (channel_id) index. Must be accurate to block the 51st add.
    const [countResult, rosterResult] = await Promise.all([
      supabase
        .from('channel_members')
        .select('id', { count: 'exact', head: true })
        .eq('channel_id', channelId),
      supabase.from('channel_members').select('user_id, role').eq('channel_id', channelId),
    ])
    if (
      countResult.error ||
      typeof countResult.count !== 'number' ||
      rosterResult.error ||
      !Array.isArray(rosterResult.data)
    ) {
      return NextResponse.json({ error: 'Failed to verify channel capacity' }, { status: 500 })
    }
    if (countResult.count > 50) {
      return NextResponse.json({ error: 'Group chat capacity is invalid' }, { status: 500 })
    }
    if (rosterResult.data.length !== countResult.count) {
      return NextResponse.json(
        { error: 'Failed to verify complete channel roster' },
        { status: 500 }
      )
    }
    const rosterIds = new Set<string>()
    let actorRosterRole: string | null = null
    for (const existingMember of rosterResult.data) {
      const parsedMemberId = channelIdSchema.safeParse(existingMember.user_id)
      if (!parsedMemberId.success || rosterIds.has(parsedMemberId.data)) {
        return NextResponse.json({ error: 'Failed to verify channel capacity' }, { status: 500 })
      }
      rosterIds.add(parsedMemberId.data)
      if (parsedMemberId.data === actorId) actorRosterRole = existingMember.role
    }
    if (actorRosterRole !== membership.role) {
      return NextResponse.json(
        { error: 'Channel authority changed during request' },
        { status: 409 }
      )
    }
    const newMemberIds = candidateIds.filter((candidateId) => !rosterIds.has(candidateId))

    if (countResult.count + newMemberIds.length > 50) {
      return NextResponse.json({ error: 'Group chat max 50 members' }, { status: 400 })
    }
    if (newMemberIds.length === 0) {
      return NextResponse.json({ ok: true, added: 0 })
    }

    const { allowed: addableIds } = await filterChannelAddableUsers(
      supabase,
      actorId,
      newMemberIds,
      [...rosterIds]
    )
    if (addableIds.length !== newMemberIds.length) {
      return NextResponse.json(
        { error: 'One or more selected users cannot be added' },
        { status: 400 }
      )
    }

    const newMembers = addableIds.map((id) => ({
      channel_id: channelId,
      user_id: id,
      role: 'member',
    }))

    const { error } = await supabase.from('channel_members').insert(newMembers)

    if (error) return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })

    return NextResponse.json({ ok: true, added: addableIds.length })
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
