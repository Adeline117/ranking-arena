/**
 * POST /api/messages/[messageId]/react
 *
 * A stable operation id and one database RPC own participant authorization,
 * account/block/message state, the toggle, absolute aggregates, notification,
 * and replay acknowledgement.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const REACTION_EMOJIS = [
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
] as const
const REACTION_EMOJI_SET = new Set<string>(REACTION_EMOJIS)
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const EmojiSchema = z.enum(REACTION_EMOJIS)
const ReactionInputSchema = z
  .object({
    operation_id: CanonicalUuidSchema,
    emoji: EmojiSchema,
  })
  .strict()
const ReactionCountsSchema = z
  .record(z.string(), z.number().int().positive())
  .superRefine((counts, context) => {
    for (const emoji of Object.keys(counts)) {
      if (!REACTION_EMOJI_SET.has(emoji)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown reaction emoji' })
      }
    }
  })
const ReactionSuccessSchema = z
  .object({
    success: z.literal(true),
    operation_id: CanonicalUuidSchema,
    actor_id: CanonicalUuidSchema,
    message_id: CanonicalUuidSchema,
    conversation_id: CanonicalUuidSchema,
    reaction_id: CanonicalUuidSchema,
    emoji: EmojiSchema,
    action: z.enum(['added', 'removed']),
    changed: z.literal(true),
    counts: ReactionCountsSchema,
    user_emojis: z.array(EmojiSchema),
    notification_id: CanonicalUuidSchema.nullable(),
    notification_created: z.boolean(),
    applied: z.boolean(),
  })
  .strict()
const ReactionFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum([
      'INVALID',
      'ACTOR_UNAVAILABLE',
      'PARTICIPANT_UNAVAILABLE',
      'MESSAGE_NOT_FOUND',
      'FORBIDDEN',
      'BLOCKED',
      'OPERATION_CONFLICT',
    ]),
  })
  .strict()
const ReactionResultSchema = z.discriminatedUnion('success', [
  ReactionSuccessSchema,
  ReactionFailureSchema,
])

type ReactionSuccess = z.infer<typeof ReactionSuccessSchema>
type ReactionFailure = z.infer<typeof ReactionFailureSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function extractMessageId(url: string): string | null {
  const pathParts = new URL(url).pathname.split('/')
  const index = pathParts.indexOf('messages')
  return index >= 0 ? (pathParts[index + 1] ?? null) : null
}

function matchesSuccess(
  result: ReactionSuccess,
  expected: { actorId: string; emoji: string; messageId: string; operationId: string }
): boolean {
  const userEmojiSet = new Set(result.user_emojis)
  return (
    userEmojiSet.size === result.user_emojis.length &&
    result.actor_id === expected.actorId &&
    result.message_id === expected.messageId &&
    result.operation_id === expected.operationId &&
    result.emoji === expected.emoji &&
    (result.action === 'added'
      ? userEmojiSet.has(result.emoji) && (result.counts[result.emoji] ?? 0) > 0
      : !userEmojiSet.has(result.emoji)) &&
    (!result.notification_created || result.notification_id !== null) &&
    (result.action === 'added' ||
      (result.notification_id === null && result.notification_created === false))
  )
}

function failureResponse(result: ReactionFailure) {
  switch (result.reason) {
    case 'INVALID':
      return privateJson({ error: 'Invalid reaction request' }, 400)
    case 'ACTOR_UNAVAILABLE':
    case 'PARTICIPANT_UNAVAILABLE':
    case 'FORBIDDEN':
    case 'BLOCKED':
      return privateJson({ error: 'No permission to react to this message' }, 403)
    case 'MESSAGE_NOT_FOUND':
      return privateJson({ error: 'Message not found' }, 404)
    case 'OPERATION_CONFLICT':
      return privateJson({ error: 'Operation id conflicts with another request' }, 409)
  }
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedMessageId = CanonicalUuidSchema.safeParse(extractMessageId(request.url))
    const parsedActorId = CanonicalUuidSchema.safeParse(user.id)
    if (!parsedMessageId.success || !parsedActorId.success) {
      return privateJson({ error: 'Invalid message id' }, 400)
    }
    const messageId = parsedMessageId.data
    const actorId = parsedActorId.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid JSON body' }, 400)
    }

    const parsedInput = ReactionInputSchema.safeParse(rawBody)
    if (!parsedInput.success) {
      return privateJson({ error: 'Invalid reaction request' }, 400)
    }
    const input = parsedInput.data

    const sb: SupabaseClient<Database> = supabase
    const { data, error } = await sb.rpc('toggle_direct_message_reaction_atomic', {
      p_operation_id: input.operation_id,
      p_message_id: messageId,
      p_actor_id: actorId,
      p_emoji: input.emoji,
    })

    if (error) {
      logger.error('Atomic direct-message reaction toggle failed', {
        code: error.code,
        actorId,
        messageId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to update reaction' }, 500)
    }

    const parsedResult = ReactionResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic direct-message reaction returned an invalid result', {
        actorId,
        messageId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to update reaction' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result)
    if (
      !matchesSuccess(result, {
        actorId,
        emoji: input.emoji,
        messageId,
        operationId: input.operation_id,
      })
    ) {
      logger.error('Atomic direct-message reaction acknowledgement mismatched its request', {
        actorId,
        messageId,
        operationId: input.operation_id,
      })
      return privateJson({ error: 'Failed to update reaction' }, 500)
    }

    return privateJson({
      success: true,
      data: {
        operationId: result.operation_id,
        messageId: result.message_id,
        action: result.action,
        emoji: result.emoji,
        counts: result.counts,
        userEmojis: result.user_emojis,
        replayed: !result.applied,
      },
    })
  },
  { name: 'messages/react-post', rateLimit: 'write' }
)
