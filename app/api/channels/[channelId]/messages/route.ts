/**
 * Channel Messages API
 * POST: Send a message to a channel
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin, getUserHandle } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'

const logger = createLogger('api:channels:channelId:messages')

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
    const { content, media_url, media_type, media_name, reply_to_id } = await request.json()

    if (!content?.trim() && !media_url) {
      return NextResponse.json({ error: 'Message content required' }, { status: 400 })
    }

    if (content && content.length > 2000) {
      return NextResponse.json({ error: 'Message too long' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

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

    const msgData: Record<string, unknown> = {
      channel_id: channelId,
      sender_id: user.id,
      content: content?.trim() || '',
    }

    if (media_url) {
      msgData.media_url = media_url
      msgData.media_type = media_type || 'file'
      msgData.media_name = media_name
    }

    // Reply / quote target — verify the parent belongs to this channel
    let parentAuthorId: string | null = null
    if (reply_to_id && typeof reply_to_id === 'string') {
      const { data: parentMsg } = await supabase
        .from('channel_messages')
        .select('id, channel_id, sender_id')
        .eq('id', reply_to_id)
        .maybeSingle()
      if (parentMsg && parentMsg.channel_id === channelId) {
        msgData.reply_to_id = reply_to_id
        parentAuthorId = parentMsg.sender_id
      }
    }

    const { data: message, error } = await supabase
      .from('channel_messages')
      .insert(msgData)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
    }

    // Notify the parent author when this message is a reply (skip self-replies).
    if (msgData.reply_to_id && parentAuthorId && parentAuthorId !== user.id) {
      fireAndForget(
        getUserHandle(user.id, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: parentAuthorId!,
              type: 'message',
              title: `${handle} replied to your message`,
              message: (content?.trim() || '').slice(0, 100) || 'replied to your message',
              actor_id: user.id,
              link: `/channels/${channelId}`,
              reference_id: message.id,
              read: false,
            },
            'Channel reply notification'
          )
        }),
        'Channel reply notification setup'
      )
    }

    // Update read status for sender
    await supabase.from('channel_message_reads').upsert({
      channel_id: channelId,
      user_id: user.id,
      last_read_at: new Date().toISOString(),
    })

    return NextResponse.json({ message })
  } catch (error) {
    logger.error('SEND_MESSAGE failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
