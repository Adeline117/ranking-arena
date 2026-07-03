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
import type { SupabaseClient } from '@supabase/supabase-js'
import { socialFeatureGuard } from '@/lib/features'
import { parseLimit } from '@/lib/utils/safe-parse'
import { sendNotification } from '@/lib/data/notifications'
import { getUserHandle } from '@/lib/supabase/server'
import { fireAndForget } from '@/lib/utils/logger'

const logger = createLogger('messages-api')

// Zod schema for POST /api/messages (send message)
const SendMessageSchema = z.object({
  receiverId: z.string().uuid('Invalid receiver ID'),
  content: z
    .string()
    .min(1, 'Message content cannot be empty')
    .max(2000, 'Message too long, max 2000 characters'),
  media_url: z.string().url().max(2000).optional().nullable(),
  media_type: z.string().max(50).optional().nullable(),
  media_name: z.string().max(255).optional().nullable(),
  reply_to_id: z.string().uuid('Invalid reply target ID').optional().nullable(),
})

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
    let query = (supabase as SupabaseClient)
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
    const sb = supabase as SupabaseClient

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

    // Permission check via single RPC call (replaces 5-7 separate queries)
    const { data: permCheck, error: permError } = await (supabase as SupabaseClient).rpc(
      'check_dm_permission',
      { p_sender_id: senderId, p_receiver_id: receiverId }
    )

    if (permError) {
      logger.error('check_dm_permission RPC error', { error: permError.message })
      return NextResponse.json({ error: 'Failed to check permissions' }, { status: 500 })
    }

    if (!permCheck?.allowed) {
      const reason = permCheck?.reason
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
            sent_count: permCheck?.sent_count,
          },
          { status: 403 }
        )
      }

      return NextResponse.json(
        { error: 'Permission denied', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    }

    // 获取或创建会话
    const orderedUser1 = senderId < receiverId ? senderId : receiverId
    const orderedUser2 = senderId < receiverId ? receiverId : senderId

    let { data: conversation } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id, created_at')
      .eq('user1_id', orderedUser1)
      .eq('user2_id', orderedUser2)
      .maybeSingle()

    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({ user1_id: orderedUser1, user2_id: orderedUser2 })
        .select()
        .single()

      if (convError) {
        if (convError.code === '23505') {
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('id, user1_id, user2_id, created_at')
            .eq('user1_id', orderedUser1)
            .eq('user2_id', orderedUser2)
            .single()
          conversation = existingConv
        } else {
          logger.error('Create conversation error', { error: convError.message })
          return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
        }
      } else {
        conversation = newConv
      }
    }

    if (!conversation) {
      return NextResponse.json({ error: 'Unable to create conversation' }, { status: 500 })
    }

    // 发送消息
    const messageData: {
      conversation_id: string
      sender_id: string
      receiver_id: string
      content: string
      media_url?: string
      media_type?: string
      media_name?: string
      reply_to_id?: string
    } = {
      conversation_id: conversation.id,
      sender_id: senderId,
      receiver_id: receiverId,
      content: content.trim(),
    }

    // Add media fields if provided
    if (media_url) {
      messageData.media_url = media_url
      messageData.media_type = media_type || 'file'
      messageData.media_name = media_name ?? undefined
    }

    // Reply target (1:1 DM quote/reply) — verify the parent belongs to this conversation
    if (reply_to_id) {
      const { data: parentMsg } = await (supabase as SupabaseClient)
        .from('direct_messages')
        .select('id, conversation_id')
        .eq('id', reply_to_id)
        .maybeSingle()
      if (parentMsg && parentMsg.conversation_id === conversation.id) {
        messageData.reply_to_id = reply_to_id
      }
    }

    const { data: message, error: msgError } = await supabase
      .from('direct_messages')
      .insert(messageData)
      .select()
      .single()

    if (msgError) {
      logger.error('Send message error', { error: msgError.message })
      traceMessage({
        event: 'failed',
        conversationId: conversation.id,
        senderId,
        receiverId,
        error: msgError.message,
      })
      return NextResponse.json(
        { error: 'Service error, please try again later', error_code: 'SERVER_ERROR' },
        { status: 500 }
      )
    }

    traceMessage({
      event: 'send',
      messageId: message.id,
      conversationId: conversation.id,
      senderId,
      receiverId,
    })

    // Notify the recipient when this message is a reply to one of their messages
    // (DMs otherwise send no notification — reply is the one signal we surface).
    if (messageData.reply_to_id) {
      fireAndForget(
        getUserHandle(senderId, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: receiverId,
              type: 'message',
              title: `${handle} replied to your message`,
              message: content.trim().slice(0, 100) || 'replied to your message',
              actor_id: senderId,
              link: `/messages/${conversation.id}`,
              reference_id: message.id,
              read: false,
            },
            'DM reply notification'
          )
        }),
        'DM reply notification setup'
      )
    }

    return NextResponse.json({
      success: true,
      message,
      conversation_id: conversation.id,
    })
  },
  { name: 'messages-send', rateLimit: 'write' }
)
