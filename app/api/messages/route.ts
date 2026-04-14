/**
 * 私信消息 API
 * GET: 获取会话中的消息（支持分页）
 * POST: 发送私信
 *
 * SECURITY: All operations require authentication. senderId is derived from
 * the authenticated user's session, preventing impersonation attacks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createLogger, traceMessage } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('messages-api')

// Zod schema for POST /api/messages (send message)
const SendMessageSchema = z.object({
  receiverId: z.string().uuid('Invalid receiver ID'),
  content: z.string().min(1, 'Message content cannot be empty').max(2000, 'Message too long, max 2000 characters'),
  media_url: z.string().url().max(2000).optional().nullable(),
  media_type: z.string().max(50).optional().nullable(),
  media_name: z.string().max(255).optional().nullable(),
})

export const dynamic = 'force-dynamic'

// 非互关用户发送消息的限制数量
const NON_MUTUAL_MESSAGE_LIMIT = 3
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

// 获取会话消息（支持 cursor 分页）
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return rateLimitResponse

    // SECURITY: Require authentication
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Please log in first', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

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

    const supabase = getSupabaseAdmin()

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
      return NextResponse.json({ error: 'No permission to access this conversation' }, { status: 403 })
    }

    // 构建查询（支持 cursor 分页）
    let query = supabase
      .from('direct_messages')
      .select(`
        id,
        sender_id,
        receiver_id,
        content,
        read,
        read_at,
        created_at,
        media_url,
        media_type,
        media_name
      `)
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

    // Mark-as-read is now handled by the dedicated POST /api/messages/read endpoint.
    // Removing auto-mark from GET to prevent duplicate read operations and unnecessary writes.

    // 获取对方用户信息
    const otherUserId = conversation.user1_id === userId ? conversation.user2_id : conversation.user1_id
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
      messages: resultMessages,
      otherUser: otherUserData,
      has_more,
    })
  } catch (error: unknown) {
    logger.error('GET error', { error: String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 发送私信
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    // SECURITY: Require authentication
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Please log in first', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const parsed = SendMessageSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', error_code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { receiverId, content, media_url, media_type, media_name } = parsed.data

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

    const supabase = getSupabaseAdmin()

    // Permission check via single RPC call (replaces 5-7 separate queries)
    const { data: permCheck, error: permError } = await supabase
      .rpc('check_dm_permission', { p_sender_id: senderId, p_receiver_id: receiverId })

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
        return NextResponse.json({
          error: `You are not mutual followers. You can only send ${NON_MUTUAL_MESSAGE_LIMIT} messages before they reply.`,
          error_code: 'PERMISSION_DENIED',
          limit_reached: true,
          sent_count: permCheck?.sent_count
        }, { status: 403 })
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
      .select('id, user1_id, user2_id, created_at, updated_at')
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
            .select('id, user1_id, user2_id, created_at, updated_at')
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
    } = {
      conversation_id: conversation.id,
      sender_id: senderId,
      receiver_id: receiverId,
      content: content.trim()
    }

    // Add media fields if provided
    if (media_url) {
      messageData.media_url = media_url
      messageData.media_type = media_type || 'file'
      messageData.media_name = media_name ?? undefined
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

    return NextResponse.json({
      success: true,
      message,
      conversation_id: conversation.id
    })
  } catch (error: unknown) {
    logger.error('POST error', { error: String(error) })
    return NextResponse.json(
      { error: 'Service error, please try again later', error_code: 'SERVER_ERROR' },
      { status: 500 }
    )
  }
}
