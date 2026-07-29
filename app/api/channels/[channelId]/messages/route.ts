/**
 * Channel Messages API
 * POST: Send a message to a channel
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin, getUserHandle } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
import { channelIdSchema, sendChannelMessageInputSchema } from '../../contracts'

const logger = createLogger('api:channels:channelId:messages')

const sendFailureReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_GROUP',
  'MEMBERSHIP_NOT_FOUND',
  'INVALID_REPLY_TARGET',
])

type SentChannelMessage = {
  id: string
  channel_id: string
  sender_id: string
  content: string
  media_url: string | null
  media_type: 'image' | 'video' | 'file' | null
  media_name: string | null
  created_at: string
  reply_to_id: string | null
}

type SendChannelMessageAcknowledgement =
  | {
      success: true
      actorId: string
      channelId: string
      message: SentChannelMessage
      readAt: string
      replyAuthorId: string | null
    }
  | { success: false; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readSentChannelMessage(value: unknown): SentChannelMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const message = value as Record<string, unknown>
  if (
    !hasExactKeys(message, [
      'channel_id',
      'content',
      'created_at',
      'id',
      'media_name',
      'media_type',
      'media_url',
      'reply_to_id',
      'sender_id',
    ]) ||
    !channelIdSchema.safeParse(message.id).success ||
    !channelIdSchema.safeParse(message.channel_id).success ||
    !channelIdSchema.safeParse(message.sender_id).success ||
    typeof message.content !== 'string' ||
    message.content.length > 2_000 ||
    (message.media_url !== null && typeof message.media_url !== 'string') ||
    ![null, 'image', 'video', 'file'].includes(message.media_type as string | null) ||
    (message.media_name !== null && typeof message.media_name !== 'string') ||
    !isTimestamp(message.created_at) ||
    (message.reply_to_id !== null && !channelIdSchema.safeParse(message.reply_to_id).success) ||
    (message.media_url === null && (message.media_type !== null || message.media_name !== null))
  ) {
    return null
  }

  return {
    id: (message.id as string).toLowerCase(),
    channel_id: (message.channel_id as string).toLowerCase(),
    sender_id: (message.sender_id as string).toLowerCase(),
    content: message.content,
    media_url: message.media_url as string | null,
    media_type: message.media_type as 'image' | 'video' | 'file' | null,
    media_name: message.media_name as string | null,
    created_at: message.created_at,
    reply_to_id: message.reply_to_id ? (message.reply_to_id as string).toLowerCase() : null,
  }
}

function readSendChannelMessageAcknowledgement(
  value: unknown
): SendChannelMessageAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !sendFailureReasons.has(result.reason)) return null
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !hasExactKeys(result, [
      'actor_id',
      'channel_id',
      'message',
      'read_at',
      'reply_author_id',
      'success',
    ])
  ) {
    return null
  }

  const actorId = channelIdSchema.safeParse(result.actor_id)
  const channelId = channelIdSchema.safeParse(result.channel_id)
  const replyAuthorId =
    result.reply_author_id === null ? null : channelIdSchema.safeParse(result.reply_author_id)
  const message = readSentChannelMessage(result.message)
  if (
    !actorId.success ||
    !channelId.success ||
    (replyAuthorId !== null && !replyAuthorId.success) ||
    !message ||
    !isTimestamp(result.read_at)
  ) {
    return null
  }

  return {
    success: true,
    actorId: actorId.data,
    channelId: channelId.data,
    message,
    readAt: result.read_at,
    replyAuthorId: replyAuthorId === null ? null : replyAuthorId.data,
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
    const parsedBody = sendChannelMessageInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid message' }, { status: 400 })
    }

    const channelId = parsedChannelId.data
    const actorId = user.id.toLowerCase()
    const content = parsedBody.data.content
    const mediaUrl = parsedBody.data.media_url ?? null
    const mediaType = mediaUrl ? parsedBody.data.media_type || 'file' : null
    const mediaName = mediaUrl ? parsedBody.data.media_name || null : null
    const replyToId = parsedBody.data.reply_to_id ?? null
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase.rpc('send_channel_message_atomic', {
      p_channel_id: channelId,
      p_sender_id: actorId,
      p_content: content,
      p_media_url: mediaUrl,
      p_media_type: mediaType,
      p_media_name: mediaName,
      p_reply_to_id: replyToId,
    })

    if (error) {
      logger.error('Atomic channel-message send failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
    }

    const acknowledgement = readSendChannelMessageAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic channel-message send returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'INVALID':
          return NextResponse.json({ error: 'Invalid message' }, { status: 400 })
        case 'ACTOR_UNAVAILABLE':
          return NextResponse.json({ error: 'Account cannot send messages' }, { status: 403 })
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support group messages' },
            { status: 400 }
          )
        case 'MEMBERSHIP_NOT_FOUND':
          return NextResponse.json({ error: 'Not a member' }, { status: 403 })
        case 'INVALID_REPLY_TARGET':
          return NextResponse.json(
            { error: 'Reply target is no longer available' },
            { status: 400 }
          )
        default:
          logger.error('Atomic channel-message send returned an unknown denial')
          return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
      }
    }

    const message = acknowledgement.message
    if (
      acknowledgement.actorId !== actorId ||
      acknowledgement.channelId !== channelId ||
      message.channel_id !== channelId ||
      message.sender_id !== actorId ||
      message.content !== content ||
      message.media_url !== mediaUrl ||
      message.media_type !== mediaType ||
      message.media_name !== mediaName ||
      message.reply_to_id !== replyToId ||
      Date.parse(acknowledgement.readAt) < Date.parse(message.created_at) ||
      (replyToId === null && acknowledgement.replyAuthorId !== null) ||
      (replyToId !== null && acknowledgement.replyAuthorId === null)
    ) {
      logger.error('Atomic channel-message acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
    }

    if (replyToId && acknowledgement.replyAuthorId && acknowledgement.replyAuthorId !== actorId) {
      fireAndForget(
        getUserHandle(actorId, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: acknowledgement.replyAuthorId!,
              type: 'message',
              title: `${handle} replied to your message`,
              message: content.slice(0, 100) || 'replied to your message',
              actor_id: actorId,
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

    return NextResponse.json({ message })
  } catch (error) {
    logger.error('SEND_MESSAGE failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
