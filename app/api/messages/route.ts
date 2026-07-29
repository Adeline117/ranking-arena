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
import { parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('messages-api')

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
    read_at: z.string().datetime().nullable(),
    created_at: z.string().datetime(),
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

// 非互关用户发送消息的限制数量
const NON_MUTUAL_MESSAGE_LIMIT = 3
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

// 获取会话消息（支持 cursor 分页）
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const conversationId = request.nextUrl.searchParams.get('conversationId')
    // SECURITY: Use authenticated user's ID, never from query params
    const userId = user.id

    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversationId' }, { status: 400 })
    }

    // 分页参数
    const before = request.nextUrl.searchParams.get('before') // cursor: created_at of oldest loaded message
    const limitParam = request.nextUrl.searchParams.get('limit')
    const limit = parseLimit(limitParam, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    // 验证用户是否有权限访问此会话
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    if (conversation.user1_id !== userId && conversation.user2_id !== userId) {
      return NextResponse.json(
        { error: 'No permission to access this conversation' },
        { status: 403 }
      )
    }

    // 构建查询（支持 cursor 分页）
    let query = supabase
      .from('direct_messages')
      .select(
        `
        id,
        sender_id,
        receiver_id,
        content,
        read,
        read_at,
        created_at,
        media_url,
        media_type,
        media_name,
        reply_to_id
      `
      )
      .eq('conversation_id', conversationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit + 1) // fetch one extra to check has_more

    // 如果有 cursor，加载更早的消息
    if (before) {
      query = query.lt('created_at', before)
    }

    const { data: messages, error: msgError } = await query

    if (msgError) {
      if (msgError.message?.includes('Could not find')) {
        return NextResponse.json({ messages: [], has_more: false })
      }
      logger.error('Query error', { error: msgError.message })
      return NextResponse.json({ error: 'Failed to fetch messages' }, { status: 500 })
    }

    // 判断是否还有更多消息
    const has_more = (messages?.length || 0) > limit
    const resultMessages = (messages || []).slice(0, limit).reverse() // reverse back to ascending order

    // Enrich with reply previews (parent snippet) + emoji reactions — batched to avoid N+1
    const sb = supabase

    const replyIds = Array.from(
      new Set(resultMessages.map((m) => m.reply_to_id).filter(Boolean))
    ) as string[]
    const replyPreviewMap = new Map<string, { sender_id: string; content: string }>()
    if (replyIds.length > 0) {
      const { data: parents } = await sb
        .from('direct_messages')
        .select('id, sender_id, content')
        .in('id', replyIds)
      for (const p of parents || []) {
        replyPreviewMap.set(p.id, {
          sender_id: p.sender_id,
          content: (p.content || '').slice(0, 120),
        })
      }
    }

    const messageIds = resultMessages.map((m) => m.id)
    const reactionMap = new Map<string, Record<string, { count: number; mine: boolean }>>()
    if (messageIds.length > 0) {
      const { data: reactionRows } = await sb
        .from('message_reactions')
        .select('message_id, emoji, user_id')
        .in('message_id', messageIds)
      for (const r of reactionRows || []) {
        let byEmoji = reactionMap.get(r.message_id)
        if (!byEmoji) {
          byEmoji = {}
          reactionMap.set(r.message_id, byEmoji)
        }
        const entry = byEmoji[r.emoji] || { count: 0, mine: false }
        entry.count += 1
        if (r.user_id === userId) entry.mine = true
        byEmoji[r.emoji] = entry
      }
    }

    const enrichedMessages = resultMessages.map((m) => ({
      ...m,
      reply_preview: m.reply_to_id ? replyPreviewMap.get(m.reply_to_id) || null : null,
      reactions: (() => {
        const byEmoji = reactionMap.get(m.id)
        if (!byEmoji) return []
        return Object.entries(byEmoji).map(([emoji, v]) => ({
          emoji,
          count: v.count,
          mine: v.mine,
        }))
      })(),
    }))

    // Mark-as-read is now handled by the dedicated POST /api/messages/read endpoint.
    // Removing auto-mark from GET to prevent duplicate read operations and unnecessary writes.

    // 获取对方用户信息
    const otherUserId =
      conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id
    const { data: otherUser } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, bio')
      .eq('id', otherUserId)
      .maybeSingle()

    // Build counterparty data with proper fallback:
    // - Use actual handle if available
    // - Fall back to full user ID (not truncated) so the profile page can resolve by UUID
    const otherUserData = otherUser
      ? {
          id: otherUser.id,
          handle: otherUser.handle || null,
          avatar_url: otherUser.avatar_url || null,
          bio: otherUser.bio || null,
        }
      : {
          id: otherUserId,
          handle: null,
          avatar_url: null,
          bio: null,
        }

    return NextResponse.json({
      messages: enrichedMessages,
      otherUser: otherUserData,
      has_more,
    })
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
