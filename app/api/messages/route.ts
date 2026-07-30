/**
 * 私信消息 API
 * GET: 获取会话中的消息（支持分页）
 * POST: 发送私信
 *
 * SECURITY: All operations require authentication. senderId is derived from
 * the authenticated user's session, preventing impersonation attacks.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { createLogger, traceMessage } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import { refreshAuthorizedChatMediaUrls } from '@/lib/chat/private-media'

const logger = createLogger('messages-api')

// 非互关用户发送消息的限制数量
const NON_MUTUAL_MESSAGE_LIMIT = 3
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

const UuidSchema = z.string().uuid()
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]?.length ?? 0) <= 6)

const MessagePageQuerySchema = z
  .object({
    conversationId: UuidSchema,
    before: TimestampSchema.optional(),
    beforeId: UuidSchema.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .optional(),
  })
  .strict()
  .refine((value) => (value.before === undefined) === (value.beforeId === undefined), {
    message: 'Both cursor fields are required',
  })

const MessageReactionSchema = z
  .object({
    emoji: z.string().min(1).max(10),
    count: z.number().int().positive(),
    mine: z.boolean(),
  })
  .strict()

const ReplyPreviewSchema = z
  .object({
    sender_id: UuidSchema,
    content: z.string().max(120),
  })
  .strict()

const ConversationPageMessageSchema = z
  .object({
    id: UuidSchema,
    sender_id: UuidSchema,
    receiver_id: UuidSchema,
    content: z.string(),
    read: z.boolean(),
    read_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
    media_url: z.string().nullable(),
    media_type: z.enum(['image', 'video', 'file']).nullable(),
    media_name: z.string().nullable(),
    reply_to_id: UuidSchema.nullable(),
    reply_preview: ReplyPreviewSchema.nullable(),
    reactions: z.array(MessageReactionSchema),
  })
  .strict()

const ConversationPageFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'NOT_FOUND', 'ACTOR_UNAVAILABLE', 'PARTICIPANT_UNAVAILABLE']),
  })
  .strict()

const ConversationPageSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    conversation_id: UuidSchema,
    other_user: z
      .object({
        id: UuidSchema,
        handle: z.string(),
        avatar_url: z.string().nullable(),
        bio: z.string().nullable(),
      })
      .strict(),
    cleared_before: TimestampSchema.nullable(),
    messages: z.array(ConversationPageMessageSchema).max(MAX_PAGE_SIZE),
    has_more: z.boolean(),
    next_cursor: z
      .object({
        before: TimestampSchema,
        before_id: UuidSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()

type MessagePageQuery = {
  before: string | null
  beforeId: string | null
  conversationId: string
  limit: number
}

type ConversationPageAcknowledgement =
  | z.infer<typeof ConversationPageFailureSchema>
  | z.infer<typeof ConversationPageSuccessSchema>

function readMessagePageQuery(searchParams: URLSearchParams): MessagePageQuery | null {
  const entries = [...searchParams.entries()]
  const raw = Object.fromEntries(entries)
  if (entries.length !== Object.keys(raw).length) return null

  const parsed = MessagePageQuerySchema.safeParse(raw)
  if (!parsed.success) return null

  return {
    conversationId: parsed.data.conversationId.toLowerCase(),
    before: parsed.data.before ?? null,
    beforeId: parsed.data.beforeId?.toLowerCase() ?? null,
    limit: parsed.data.limit === undefined ? DEFAULT_PAGE_SIZE : Number(parsed.data.limit),
  }
}

function timestampMicros(value: string): number | null {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  if (fraction.length > 6) return null
  const microsWithinMillisecond = Number(fraction.padEnd(6, '0').slice(3, 6))
  return milliseconds * 1000 + microsWithinMillisecond
}

function compareMessagePosition(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string }
): number | null {
  const leftTime = timestampMicros(left.created_at)
  const rightTime = timestampMicros(right.created_at)
  if (leftTime === null || rightTime === null) return null
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function readConversationPageAcknowledgement(
  value: unknown
): ConversationPageAcknowledgement | null {
  const failure = ConversationPageFailureSchema.safeParse(value)
  if (failure.success) return failure.data

  const success = ConversationPageSuccessSchema.safeParse(value)
  if (!success.success) return null
  return success.data
}

function pageAcknowledgementMatchesRequest(
  acknowledgement: z.infer<typeof ConversationPageSuccessSchema>,
  request: MessagePageQuery,
  actorId: string
): boolean {
  if (
    acknowledgement.actor_id !== actorId ||
    acknowledgement.conversation_id !== request.conversationId ||
    acknowledgement.other_user.id === actorId ||
    acknowledgement.messages.length > request.limit ||
    (acknowledgement.has_more && acknowledgement.messages.length !== request.limit) ||
    acknowledgement.has_more !== (acknowledgement.next_cursor !== null)
  ) {
    return false
  }

  const messageIds = new Set<string>()
  const clearedAt =
    acknowledgement.cleared_before === null ? null : timestampMicros(acknowledgement.cleared_before)
  if (acknowledgement.cleared_before !== null && clearedAt === null) return false

  for (let index = 0; index < acknowledgement.messages.length; index += 1) {
    const message = acknowledgement.messages[index]
    if (!message || messageIds.has(message.id)) return false
    messageIds.add(message.id)

    const participantPairIsExact =
      (message.sender_id === actorId && message.receiver_id === acknowledgement.other_user.id) ||
      (message.sender_id === acknowledgement.other_user.id && message.receiver_id === actorId)
    if (!participantPairIsExact) return false
    if (
      message.reply_preview !== null &&
      message.reply_preview.sender_id !== actorId &&
      message.reply_preview.sender_id !== acknowledgement.other_user.id
    ) {
      return false
    }

    const messageTime = timestampMicros(message.created_at)
    if (messageTime === null || (clearedAt !== null && messageTime <= clearedAt)) return false

    const emojis = message.reactions.map((reaction) => reaction.emoji)
    if (new Set(emojis).size !== emojis.length) return false

    const previous = acknowledgement.messages[index - 1]
    if (previous) {
      const order = compareMessagePosition(previous, message)
      if (order === null || order >= 0) return false
    }

    if (request.before !== null && request.beforeId !== null) {
      const cursorOrder = compareMessagePosition(message, {
        created_at: request.before,
        id: request.beforeId,
      })
      if (cursorOrder === null || cursorOrder >= 0) return false
    }
  }

  if (acknowledgement.next_cursor !== null) {
    const oldest = acknowledgement.messages[0]
    if (
      !oldest ||
      acknowledgement.next_cursor.before !== oldest.created_at ||
      acknowledgement.next_cursor.before_id !== oldest.id
    ) {
      return false
    }
  }

  return true
}

// Zod schema for POST /api/messages (send message)
const SendMessageSchema = z.object({
  receiverId: z.string().uuid('Invalid receiver ID'),
  content: z
    .string()
    .trim()
    .min(1, 'Message content cannot be empty')
    .max(2000, 'Message too long, max 2000 characters'),
  media_url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((value) => value.startsWith('https://'), 'Media URL must use HTTPS')
    .optional()
    .nullable(),
  media_type: z.enum(['image', 'video', 'file']).optional().nullable(),
  media_name: z.string().trim().min(1).max(255).optional().nullable(),
  reply_to_id: z.string().uuid('Invalid reply target ID').optional().nullable(),
})

const AtomicMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    sender_id: z.string().uuid(),
    receiver_id: z.string().uuid(),
    content: z.string().min(1).max(2000),
    read: z.boolean(),
    read_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    deleted_at: z.null(),
    media_url: z.string().nullable(),
    media_type: z.enum(['image', 'video', 'file']).nullable(),
    media_name: z.string().nullable(),
    reply_to_id: z.string().uuid().nullable(),
  })
  .passthrough()

type AtomicSendResult =
  | {
      success: true
      conversationId: string
      message: z.infer<typeof AtomicMessageSchema>
    }
  | {
      success: false
      reason:
        | 'BLOCKED'
        | 'DM_DISABLED'
        | 'INVALID_REPLY_TARGET'
        | 'LIMIT_REACHED'
        | 'SENDER_UNAVAILABLE'
        | 'USER_NOT_FOUND'
      sentCount?: number
    }

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function readAtomicSendResult(value: unknown): AtomicSendResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (result.success === true) {
    if (
      !exactKeys(result, ['allowed', 'conversation_id', 'message', 'success']) ||
      result.allowed !== true ||
      typeof result.conversation_id !== 'string'
    ) {
      return null
    }
    const parsedMessage = AtomicMessageSchema.safeParse(result.message)
    if (!parsedMessage.success || parsedMessage.data.conversation_id !== result.conversation_id) {
      return null
    }
    return {
      success: true,
      conversationId: result.conversation_id,
      message: parsedMessage.data,
    }
  }

  if (result.success !== false || result.allowed !== false || typeof result.reason !== 'string') {
    return null
  }
  const reason = result.reason
  if (reason === 'LIMIT_REACHED') {
    if (
      !exactKeys(result, ['allowed', 'reason', 'sent_count', 'success']) ||
      !Number.isSafeInteger(result.sent_count) ||
      (result.sent_count as number) < NON_MUTUAL_MESSAGE_LIMIT
    ) {
      return null
    }
    return { success: false, reason, sentCount: result.sent_count as number }
  }
  if (
    !exactKeys(result, ['allowed', 'reason', 'success']) ||
    ![
      'BLOCKED',
      'DM_DISABLED',
      'INVALID_REPLY_TARGET',
      'SENDER_UNAVAILABLE',
      'USER_NOT_FOUND',
    ].includes(reason)
  ) {
    return null
  }
  return {
    success: false,
    reason: reason as Exclude<AtomicSendResult, { success: true }>['reason'],
  }
}

export const dynamic = 'force-dynamic'

// 获取会话消息（支持 cursor 分页）
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const input = readMessagePageQuery(request.nextUrl.searchParams)
    if (!input) {
      return NextResponse.json({ error: 'Invalid message request' }, { status: 400 })
    }

    const actorId = UuidSchema.safeParse(user.id)
    if (!actorId.success) {
      return NextResponse.json(
        { error: 'No permission to access this conversation' },
        { status: 403 }
      )
    }

    const normalizedActorId = actorId.data.toLowerCase()
    const { data, error } = await supabase.rpc('get_direct_message_conversation_page_atomic', {
      p_conversation_id: input.conversationId,
      p_actor_id: normalizedActorId,
      p_before_created_at: input.before,
      p_before_id: input.beforeId,
      p_limit: input.limit,
    })

    if (error) {
      logger.error('Atomic conversation page read failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
    }

    const acknowledgement = readConversationPageAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic conversation page read returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'INVALID':
          return NextResponse.json({ error: 'Invalid message request' }, { status: 400 })
        case 'NOT_FOUND':
          return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
        case 'ACTOR_UNAVAILABLE':
        case 'PARTICIPANT_UNAVAILABLE':
          return NextResponse.json(
            { error: 'No permission to access this conversation' },
            { status: 403 }
          )
      }
    }

    if (!pageAcknowledgementMatchesRequest(acknowledgement, input, normalizedActorId)) {
      logger.error('Atomic conversation page acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
    }

    const authorizedMessages = await refreshAuthorizedChatMediaUrls(
      supabase,
      acknowledgement.messages,
      input.conversationId
    )

    return NextResponse.json(
      {
        messages: authorizedMessages,
        otherUser: acknowledgement.other_user,
        cleared_before: acknowledgement.cleared_before,
        has_more: acknowledgement.has_more,
        next_cursor: acknowledgement.next_cursor,
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    )
  },
  { name: 'messages-get', rateLimit: 'authenticated' }
)

// 发送私信
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const parsed = SendMessageSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', error_code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { receiverId, content, media_url, media_type, media_name, reply_to_id } = parsed.data

    // SECURITY: Explicitly reject client-provided senderId to prevent impersonation
    if ('senderId' in body && body.senderId !== user.id) {
      return NextResponse.json(
        { error: 'Cannot specify senderId', error_code: 'IMPERSONATION_BLOCKED' },
        { status: 403 }
      )
    }
    const senderId = user.id

    if (senderId === receiverId) {
      return NextResponse.json(
        { error: 'Cannot send message to yourself', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    // Permission, non-mutual quota, canonical conversation creation, reply
    // validation and the insert must share one database transaction. A
    // route-level check followed by a service-role insert lets a concurrent
    // block, privacy change or third send race through stale permission.
    const { data: rawResult, error: sendError } = await supabase.rpc('send_direct_message_atomic', {
      p_sender_id: senderId,
      p_receiver_id: receiverId,
      p_content: content,
      p_media_url: media_url ?? null,
      p_media_type: media_url ? media_type || 'file' : null,
      p_media_name: media_url ? (media_name ?? null) : null,
      p_reply_to_id: reply_to_id ?? null,
    })
    const sendResult = readAtomicSendResult(rawResult)

    if (sendError || !sendResult) {
      logger.error('Atomic direct-message send failed', {
        code: sendError?.code,
        senderId,
        receiverId,
      })
      traceMessage({
        event: 'failed',
        senderId,
        receiverId,
        error: 'Atomic direct-message send failed',
      })
      return NextResponse.json(
        { error: 'Service error, please try again later', error_code: 'SERVER_ERROR' },
        { status: 500 }
      )
    }

    if (!sendResult.success) {
      const reason = sendResult.reason
      traceMessage({
        event: 'failed',
        senderId,
        receiverId,
        error: `DM permission denied: ${reason}`,
      })

      if (reason === 'USER_NOT_FOUND') {
        return NextResponse.json({ error: 'User not found' }, { status: 404 })
      }

      if (reason === 'DM_DISABLED') {
        return NextResponse.json(
          { error: 'This user has disabled direct messages', error_code: 'PERMISSION_DENIED' },
          { status: 403 }
        )
      }

      if (reason === 'LIMIT_REACHED') {
        return NextResponse.json(
          {
            error: `You are not mutual followers. You can only send ${NON_MUTUAL_MESSAGE_LIMIT} messages before they reply.`,
            error_code: 'PERMISSION_DENIED',
            limit_reached: true,
            sent_count: sendResult.sentCount,
          },
          { status: 403 }
        )
      }

      if (reason === 'INVALID_REPLY_TARGET') {
        return NextResponse.json(
          { error: 'Reply target is no longer available', error_code: 'VALIDATION_ERROR' },
          { status: 400 }
        )
      }

      return NextResponse.json(
        { error: 'Permission denied', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    }

    const message = sendResult.message
    if (
      message.sender_id !== senderId ||
      message.receiver_id !== receiverId ||
      message.content !== content.trim() ||
      message.media_url !== (media_url ?? null) ||
      message.media_type !== (media_url ? media_type || 'file' : null) ||
      message.media_name !== (media_url ? (media_name ?? null) : null) ||
      message.reply_to_id !== (reply_to_id ?? null)
    ) {
      logger.error('Atomic direct-message send returned mismatched evidence', {
        messageId: message.id,
        senderId,
        receiverId,
      })
      traceMessage({
        event: 'failed',
        conversationId: sendResult.conversationId,
        senderId,
        receiverId,
        error: 'Atomic direct-message acknowledgement mismatch',
      })
      return NextResponse.json(
        { error: 'Service error, please try again later', error_code: 'SERVER_ERROR' },
        { status: 500 }
      )
    }

    traceMessage({
      event: 'send',
      messageId: message.id,
      conversationId: sendResult.conversationId,
      senderId,
      receiverId,
    })

    return NextResponse.json({
      success: true,
      message,
      conversation_id: sendResult.conversationId,
    })
  },
  { name: 'messages-send', rateLimit: 'write' }
)
