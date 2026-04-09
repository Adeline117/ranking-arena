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

    const { channelId } = await params
    const { userIds } = await request.json()

    if (!userIds?.length) {
      return NextResponse.json({ error: 'No users specified' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Check admin/owner
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Check total member count
    // KEEP 'exact' — 50 member cap enforcement. Scoped per-channel via
    // (channel_id) index. Must be accurate to block the 51st add.
    const { count } = await supabase
      .from('channel_members')
      .select('id', { count: 'exact', head: true })
      .eq('channel_id', channelId)

    if ((count || 0) + userIds.length > 50) {
      return NextResponse.json({ error: 'Group chat max 50 members' }, { status: 400 })
    }

    const newMembers = userIds.map((id: string) => ({
      channel_id: channelId,
      user_id: id,
      role: 'member',
    }))

    const { error } = await supabase
      .from('channel_members')
      .upsert(newMembers, { onConflict: 'channel_id,user_id' })

    if (error) return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })

    return NextResponse.json({ ok: true, added: userIds.length })
  } catch (error) {
    logger.error('ADD_MEMBERS failed', { error: error instanceof Error ? error.message : String(error) })
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

    const { channelId } = await params
    const { userId: targetUserId } = await request.json()
    const supabase = getSupabaseAdmin()

    // If removing self = leaving
    if (targetUserId === user.id) {
      // Owner can't leave, must transfer or dissolve
      const { data: mem } = await supabase
        .from('channel_members')
        .select('role')
        .eq('channel_id', channelId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (mem?.role === 'owner') {
        return NextResponse.json({ error: 'Owner cannot leave. Please transfer ownership or disband the group first.' }, { status: 400 })
      }

      await supabase
        .from('channel_members')
        .delete()
        .eq('channel_id', channelId)
        .eq('user_id', user.id)

      return NextResponse.json({ ok: true, action: 'left' })
    }

    // Removing another user - need admin/owner
    const { data: myMembership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!myMembership || !['owner', 'admin'].includes(myMembership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // Can't remove owner
    const { data: targetMem } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', targetUserId)
      .maybeSingle()

    if (targetMem?.role === 'owner') {
      return NextResponse.json({ error: 'Cannot remove the group owner' }, { status: 400 })
    }

    // Admin can only remove members, not other admins (unless owner)
    if (myMembership.role === 'admin' && targetMem?.role === 'admin') {
      return NextResponse.json({ error: 'Admins cannot remove other admins' }, { status: 403 })
    }

    await supabase
      .from('channel_members')
      .delete()
      .eq('channel_id', channelId)
      .eq('user_id', targetUserId)

    return NextResponse.json({ ok: true, action: 'removed' })
  } catch (error) {
    logger.error('REMOVE_MEMBER failed', { error: error instanceof Error ? error.message : String(error) })
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

    const { channelId } = await params
    const { userId: targetUserId, role } = await request.json()
    const supabase = getSupabaseAdmin()

    // Owner only can change roles
    const { data: myMem } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!myMem || myMem.role !== 'owner') {
      return NextResponse.json({ error: 'Only owner can change roles' }, { status: 403 })
    }

    if (!['admin', 'member'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    await supabase
      .from('channel_members')
      .update({ role })
      .eq('channel_id', channelId)
      .eq('user_id', targetUserId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('UPDATE_MEMBER_ROLE failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
