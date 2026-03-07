/**
 * Chat Channels API
 * GET: List user's channels (direct + group)
 * POST: Create a new group channel
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('api:channels')

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const type = request.nextUrl.searchParams.get('type') // 'group' | 'all'

    // Get channels the user is a member of
    const query = supabase
      .from('channel_members')
      .select(`
        channel_id,
        role,
        is_muted,
        is_pinned,
        chat_channels (
          id, name, type, avatar_url, description,
          last_message_at, last_message_preview, created_by
        )
      `)
      .eq('user_id', user.id)

    const { data: memberships, error } = await query
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    let channels = (memberships || [])
      .filter(m => m.chat_channels)
      .map(m => {
        const ch = m.chat_channels as unknown as Record<string, unknown>
        return {
          id: ch.id,
          name: ch.name,
          type: ch.type,
          avatar_url: ch.avatar_url,
          description: ch.description,
          last_message_at: ch.last_message_at,
          last_message_preview: ch.last_message_preview,
          role: m.role,
          is_muted: m.is_muted,
          is_pinned: m.is_pinned,
        }
      })

    if (type === 'group') {
      channels = channels.filter(c => c.type === 'group')
    }

    // Sort: pinned first, then by last_message_at
    channels.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return new Date(b.last_message_at as string).getTime() - new Date(a.last_message_at as string).getTime()
    })

    return NextResponse.json({ channels })
  } catch (error) {
    logger.error('GET /api/channels failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { name, memberIds, description } = await request.json()

    if (!name?.trim()) {
      return NextResponse.json({ error: 'Please enter a group name' }, { status: 400 })
    }

    if (!memberIds || memberIds.length < 1) {
      return NextResponse.json({ error: 'Select at least 1 member' }, { status: 400 })
    }

    if (memberIds.length > 50) {
      return NextResponse.json({ error: 'Group cannot exceed 50 members' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Create the channel
    const { data: channel, error: channelError } = await supabase
      .from('chat_channels')
      .insert({
        name: name.trim(),
        type: 'group',
        created_by: user.id,
        description: description?.trim() || null,
      })
      .select()
      .single()

    if (channelError) {
      return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
    }

    // Add the creator as owner
    const members = [
      { channel_id: channel.id, user_id: user.id, role: 'owner' },
      ...memberIds.map((id: string) => ({
        channel_id: channel.id,
        user_id: id,
        role: 'member',
      })),
    ]

    const { error: memberError } = await supabase
      .from('channel_members')
      .insert(members)

    if (memberError) {
      // Cleanup channel if member insert fails
      await supabase.from('chat_channels').delete().eq('id', channel.id)
      return NextResponse.json({ error: 'Failed to add members' }, { status: 500 })
    }

    return NextResponse.json({ channel })
  } catch (error) {
    logger.error('POST /api/channels failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
