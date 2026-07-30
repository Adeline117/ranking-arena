/**
 * Channel Message Emoji Reactions API
 * POST /api/channels/[channelId]/messages/[messageId]/react - Toggle an emoji
 * reaction on a group channel message. A durable operation ID makes an
 * uncertain transport replay return the original toggle acknowledgement.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin, getUserHandle } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { sendNotification } from '@/lib/data/notifications'
import {
  channelIdSchema,
  channelMessageReactionEmojis,
  toggleChannelMessageReactionInputSchema,
} from '../../../../contracts'

const logger = createLogger('api:channels:channelId:messages:react')

const reactionFailureReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_GROUP',
  'MEMBERSHIP_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'OPERATION_CONFLICT',
])

type ReactionAction = 'added' | 'removed'

type ToggleReactionAcknowledgement =
  | {
      success: true
      operationId: string
      actorId: string
      channelId: string
      messageId: string
      reactionId: string
      emoji: (typeof channelMessageReactionEmojis)[number]
      action: ReactionAction
      counts: Record<string, number>
      userEmojis: string[]
      messageAuthorId: string
      messagePreview: string
      applied: boolean
    }
  | { success: false; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function readReactionCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const entries: Array<[string, number]> = []
  for (const [emoji, count] of Object.entries(value as Record<string, unknown>)) {
    if (
      emoji.length === 0 ||
      emoji.length > 32 ||
      !Number.isSafeInteger(count) ||
      (count as number) < 1
    ) {
      return null
    }
    entries.push([emoji, count as number])
  }
  return Object.fromEntries(entries)
}

function readToggleReactionAcknowledgement(value: unknown): ToggleReactionAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !reactionFailureReasons.has(result.reason)) return null
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !hasExactKeys(result, [
      'action',
      'applied',
      'actor_id',
      'changed',
      'channel_id',
      'counts',
      'emoji',
      'message_author_id',
      'message_id',
      'message_preview',
      'operation_id',
      'reaction_id',
      'success',
      'user_emojis',
    ]) ||
    result.changed !== true ||
    typeof result.applied !== 'boolean' ||
    (result.action !== 'added' && result.action !== 'removed') ||
    typeof result.emoji !== 'string' ||
    !channelMessageReactionEmojis.includes(
      result.emoji as (typeof channelMessageReactionEmojis)[number]
    ) ||
    !Array.isArray(result.user_emojis) ||
    typeof result.message_preview !== 'string'
  ) {
    return null
  }

  const actorId = channelIdSchema.safeParse(result.actor_id)
  const operationId = channelIdSchema.safeParse(result.operation_id)
  const channelId = channelIdSchema.safeParse(result.channel_id)
  const messageId = channelIdSchema.safeParse(result.message_id)
  const reactionId = channelIdSchema.safeParse(result.reaction_id)
  const messageAuthorId = channelIdSchema.safeParse(result.message_author_id)
  const counts = readReactionCounts(result.counts)
  if (
    !operationId.success ||
    !actorId.success ||
    !channelId.success ||
    !messageId.success ||
    !reactionId.success ||
    !messageAuthorId.success ||
    !counts
  ) {
    return null
  }

  const userEmojis: string[] = []
  for (const emoji of result.user_emojis) {
    if (
      typeof emoji !== 'string' ||
      emoji.length === 0 ||
      emoji.length > 32 ||
      userEmojis.includes(emoji) ||
      counts[emoji] === undefined
    ) {
      return null
    }
    userEmojis.push(emoji)
  }

  return {
    success: true,
    operationId: operationId.data,
    actorId: actorId.data,
    channelId: channelId.data,
    messageId: messageId.data,
    reactionId: reactionId.data,
    emoji: result.emoji as (typeof channelMessageReactionEmojis)[number],
    action: result.action,
    counts,
    userEmojis,
    messageAuthorId: messageAuthorId.data,
    messagePreview: result.message_preview,
    applied: result.applied,
  }
}

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string; messageId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const rawParams = await params
    const parsedChannelId = channelIdSchema.safeParse(rawParams.channelId)
    const parsedMessageId = channelIdSchema.safeParse(rawParams.messageId)
    if (!parsedChannelId.success || !parsedMessageId.success) {
      return NextResponse.json({ error: 'Invalid channel or message id' }, { status: 400 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = toggleChannelMessageReactionInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid reaction request' }, { status: 400 })
    }

    const channelId = parsedChannelId.data
    const messageId = parsedMessageId.data
    const actorId = user.id.toLowerCase()
    const operationId = parsedBody.data.operation_id
    const emoji = parsedBody.data.emoji
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.rpc('toggle_channel_message_reaction_idempotent', {
      p_operation_id: operationId,
      p_channel_id: channelId,
      p_message_id: messageId,
      p_actor_id: actorId,
      p_emoji: emoji,
    })

    if (error) {
      logger.error('Atomic channel reaction toggle failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }

    const acknowledgement = readToggleReactionAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic channel reaction toggle returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'INVALID':
          return NextResponse.json({ error: 'Invalid reaction request' }, { status: 400 })
        case 'ACTOR_UNAVAILABLE':
          return NextResponse.json({ error: 'Account cannot react' }, { status: 403 })
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support group reactions' },
            { status: 400 }
          )
        case 'MEMBERSHIP_NOT_FOUND':
          return NextResponse.json({ error: 'Not a member' }, { status: 403 })
        case 'MESSAGE_NOT_FOUND':
          return NextResponse.json({ error: 'Message not found' }, { status: 404 })
        case 'OPERATION_CONFLICT':
          return NextResponse.json(
            { error: 'Operation id conflicts with another request' },
            { status: 409 }
          )
        default:
          logger.error('Atomic channel reaction toggle returned an unknown denial')
          return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
      }
    }

    if (
      acknowledgement.actorId !== actorId ||
      acknowledgement.operationId !== operationId ||
      acknowledgement.channelId !== channelId ||
      acknowledgement.messageId !== messageId ||
      acknowledgement.emoji !== emoji ||
      (acknowledgement.action === 'added' &&
        (!acknowledgement.userEmojis.includes(emoji) ||
          (acknowledgement.counts[emoji] ?? 0) < 1)) ||
      (acknowledgement.action === 'removed' && acknowledgement.userEmojis.includes(emoji))
    ) {
      logger.error('Atomic channel reaction acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to update reaction' }, { status: 500 })
    }

    if (
      acknowledgement.applied &&
      acknowledgement.action === 'added' &&
      acknowledgement.messageAuthorId !== actorId
    ) {
      fireAndForget(
        getUserHandle(actorId, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: acknowledgement.messageAuthorId,
              type: 'reaction',
              title: `${handle} reacted ${emoji} to your message`,
              message: acknowledgement.messagePreview || 'your message',
              actor_id: actorId,
              link: `/channels/${channelId}`,
              // One actor may add several allowed emoji to the same message.
              // Keep retries of one emoji idempotent without swallowing the
              // other distinct reactions.
              reference_id: `channel-reaction:${messageId}:${encodeURIComponent(emoji)}`,
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
      data: {
        operationId,
        messageId,
        action: acknowledgement.action,
        emoji,
        counts: acknowledgement.counts,
        userEmojis: acknowledgement.userEmojis,
        replayed: !acknowledgement.applied,
      },
    })
  } catch (error) {
    logger.error('REACT failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
