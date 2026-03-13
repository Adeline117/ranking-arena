/**
 * Channel detail API
 * GET: Get channel info + members + messages
 * PATCH: Update channel settings (name, avatar, description)
 * DELETE: Dissolve channel (owner only)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:channels:channelId')

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId } = await params
    const supabase = getSupabaseAdmin()

    // Verify membership
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    // Get channel info
    const { data: channel } = await supabase
      .from('chat_channels')
      .select('id, name, avatar_url, description, type, created_by, created_at, updated_at')
      .eq('id', channelId)
      .single()

    // Get members with profiles
    const { data: members } = await supabase
      .from('channel_members')
      .select('user_id, role, nickname, joined_at')
      .eq('channel_id', channelId)

    // Get member profiles
    const memberIds = members?.map(m => m.user_id) || []
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url')
      .in('id', memberIds)

    const profileMap = new Map((profiles || []).map(p => [p.id, p]))

    const membersWithProfiles = (members || []).map(m => ({
      ...m,
      handle: profileMap.get(m.user_id)?.handle || null,
      avatar_url: profileMap.get(m.user_id)?.avatar_url || null,
    }))

    // Get messages (latest 50)
    const before = request.nextUrl.searchParams.get('before')
    let msgQuery = supabase
      .from('channel_messages')
      .select('id, sender_id, content, media_url, media_type, media_name, created_at')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(51)

    if (before) {
      msgQuery = msgQuery.lt('created_at', before)
    }

    const { data: messages } = await msgQuery
    const hasMore = (messages?.length || 0) > 50
    const resultMessages = (messages || []).slice(0, 50).reverse()

    // Update read status
    await supabase
      .from('channel_message_reads')
      .upsert({
        channel_id: channelId,
        user_id: user.id,
        last_read_at: new Date().toISOString(),
      })

    return NextResponse.json({
      channel,
      members: membersWithProfiles,
      messages: resultMessages,
      has_more: hasMore,
      my_role: membership.role,
    })
  } catch (error) {
    logger.error('GET_CHANNEL failed', { error: error instanceof Error ? error.message : String(error) })
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
    const supabase = getSupabaseAdmin()

    // Check admin/owner role
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const body = await request.json()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url
    if (body.description !== undefined) updates.description = body.description?.trim() || null

    const { data: channel, error } = await supabase
      .from('chat_channels')
      .update(updates)
      .eq('id', channelId)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ channel })
  } catch (error) {
    logger.error('PATCH_CHANNEL failed', { error: error instanceof Error ? error.message : String(error) })
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
    const supabase = getSupabaseAdmin()

    // Owner only
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || membership.role !== 'owner') {
      return NextResponse.json({ error: 'Only owner can dissolve' }, { status: 403 })
    }

    await supabase.from('chat_channels').delete().eq('id', channelId)

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('DELETE_CHANNEL failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
