/**
 * Channel Message Emoji Reactions API
 * POST /api/channels/[channelId]/messages/[messageId]/react - Toggle an emoji
 * reaction on a group channel message.
 *
 * Mirrors app/api/messages/[messageId]/react/route.ts:
 *   check existing row → delete or insert → re-aggregate → return { counts, userEmojis }
 *
 * SECURITY: caller must be a member of the channel (verified via channel_members).
 * On ADD, the message author is notified (skip self-reactions); reactions are NOT
 * fanned out to all members.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin, getUserHandle } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'

const logger = createLogger('api:channels:channelId:messages:react')

export const dynamic = 'force-dynamic'

// Allowed emoji set — mirrors the DM / post reaction allowlist
const ALLOWED_EMOJIS = new Set([
  '👍',
  '🔥',
  '💎',
  '🚀',
  '❤️',
  '👀',
  '🎯',
  '💰',
  '📈',
  '📉',
  '🤔',
  '😂',
])

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string; messageId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId, messageId } = await params

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const emoji = body.emoji as string

    if (!emoji || !ALLOWED_EMOJIS.has(emoji)) {
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Verify caller is a member of the channel
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    // Verify the message exists and belongs to this channel
    const { data: parentMsg } = await supabase
      .from('channel_messages')
      .select('id, channel_id, sender_id, content')
      .eq('id', messageId)
      .maybeSingle()

    if (!parentMsg || parentMsg.channel_id !== channelId) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    // Toggle: check existing reaction
    const { data: existing } = await supabase
      .from('channel_message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', user.id)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existing) {
      await supabase.from('channel_message_reactions').delete().eq('id', existing.id)
    } else {
      await supabase.from('channel_message_reactions').insert({
        message_id: messageId,
        user_id: user.id,
        emoji,
      })
    }

    // Re-aggregate counts for this message
    const { data: reactions } = await supabase
      .from('channel_message_reactions')
      .select('emoji, user_id')
      .eq('message_id', messageId)

    const counts: Record<string, number> = {}
    const userEmojis: string[] = []
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
      if (r.user_id === user.id) userEmojis.push(r.emoji)
    }

    // Notify the message author when a reaction is ADDED (skip self-reactions).
    // Single-recipient only — never fan out to all channel members.
    if (!existing && parentMsg.sender_id && parentMsg.sender_id !== user.id) {
      fireAndForget(
        getUserHandle(user.id, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: parentMsg.sender_id,
              type: 'reaction',
              title: `${handle} reacted ${emoji} to your message`,
              message: (parentMsg.content || '').slice(0, 100) || 'your message',
              actor_id: user.id,
              link: `/channels/${channelId}`,
              reference_id: messageId,
              read: false,
            },
            'Channel reaction notification'
          )
        }),
        'Channel reaction notification setup'
      )
    }

    return NextResponse.json({
      success: true,
      action: existing ? 'removed' : 'added',
      emoji,
      counts,
      userEmojis,
    })
  } catch (error) {
    logger.error('REACT failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
