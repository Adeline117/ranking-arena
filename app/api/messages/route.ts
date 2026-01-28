/**
 * 私信消息 API
 * GET: 获取会话中的消息（支持分页）
 * POST: 发送私信
 *
 * SECURITY: All operations require authentication. senderId is derived from
 * the authenticated user's session, preventing impersonation attacks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createLogger, traceMessage } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'

const logger = createLogger('messages-api')

export const dynamic = 'force-dynamic'

// 非互关用户发送消息的限制数量
const NON_MUTUAL_MESSAGE_LIMIT = 3
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

// 获取会话消息（支持 cursor 分页）
export async function GET(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: '请先登录', error_code: 'NOT_AUTHENTICATED' },
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
    const limit = Math.min(Math.max(parseInt(limitParam || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)

    const supabase = getSupabaseAdmin()

    // 验证用户是否有权限访问此会话
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversationId)
      .maybeSingle()

    if (convError || !conversation) {
      return NextResponse.json({ error: '会话不存在' }, { status: 404 })
    }

    if (conversation.user1_id !== userId && conversation.user2_id !== userId) {
      return NextResponse.json({ error: '无权访问此会话' }, { status: 403 })
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
        created_at,
        media_url,
        media_type,
        media_name
      `)
      .eq('conversation_id', conversationId)
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
      return NextResponse.json({ error: msgError.message }, { status: 500 })
    }

    // 判断是否还有更多消息
    const has_more = (messages?.length || 0) > limit
    const resultMessages = (messages || []).slice(0, limit).reverse() // reverse back to ascending order

    // 标记接收到的消息为已读（仅首次加载时，不在翻页时重复执行）
    if (!before) {
      const { data: updatedMessages, error: readUpdateError } = await supabase
        .from('direct_messages')
        .update({ read: true })
        .eq('conversation_id', conversationId)
        .eq('receiver_id', userId)
        .eq('read', false)
        .select('id')

      if (readUpdateError) {
        logger.warn('Failed to mark messages as read', { error: readUpdateError.message, conversationId, userId })
      }

      if (updatedMessages && updatedMessages.length > 0) {
        traceMessage({
          event: 'read',
          conversationId,
          receiverId: userId,
          metadata: { count: updatedMessages.length },
        })
      }
    }

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
  } catch (error) {
    logger.error('GET error', { error: String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 发送私信
export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: '请先登录', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { receiverId, content, media_url, media_type, media_name } = body

    // SECURITY: Use authenticated user's ID as sender, ignoring any client-provided senderId.
    // This prevents users from sending messages impersonating other users.
    const senderId = user.id

    if (!receiverId || !content) {
      return NextResponse.json(
        { error: '缺少接收者或消息内容', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    if (senderId === receiverId) {
      return NextResponse.json(
        { error: '不能给自己发私信', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    if (content.trim().length === 0) {
      return NextResponse.json(
        { error: '消息内容不能为空', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    if (content.length > 2000) {
      return NextResponse.json(
        { error: '消息内容过长，最多2000字符', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()


    // 获取接收者的隐私设置
    const { data: receiverProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('dm_permission')
      .eq('id', receiverId)
      .maybeSingle()

    if (profileError || !receiverProfile) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 })
    }

    // 检查接收者的私信权限设置
    const dmPermission = receiverProfile.dm_permission || 'mutual'

    if (dmPermission === 'none') {
      traceMessage({
        event: 'failed',
        senderId,
        receiverId,
        error: 'DM permission denied: recipient disabled DMs',
      })
      return NextResponse.json(
        { error: '该用户已关闭私信功能', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    }

    // 检查是否互相关注
    const { data: senderFollows } = await supabase
      .from('user_follows')
      .select('*')
      .eq('follower_id', senderId)
      .eq('following_id', receiverId)
      .maybeSingle()

    const { data: receiverFollows } = await supabase
      .from('user_follows')
      .select('*')
      .eq('follower_id', receiverId)
      .eq('following_id', senderId)
      .maybeSingle()

    const isMutualFollow = !!senderFollows && !!receiverFollows

    // 如果设置为仅互相关注可以私信，且不是互关
    if (dmPermission === 'mutual' && !isMutualFollow) {
      const { data: receiverReplied, error: replyError } = await supabase
        .from('direct_messages')
        .select('id')
        .eq('sender_id', receiverId)
        .eq('receiver_id', senderId)
        .limit(1)
        .maybeSingle()

      if (replyError && !replyError.message?.includes('Could not find')) {
        logger.warn('Query reply error', { error: replyError.message })
      }

      if (!receiverReplied) {
        const { count: sentCount, error: countError } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('sender_id', senderId)
          .eq('receiver_id', receiverId)

        if (countError && !countError.message?.includes('Could not find')) {
          logger.warn('Count messages error', { error: countError.message })
        }

        const currentCount = sentCount || 0
        if (currentCount >= NON_MUTUAL_MESSAGE_LIMIT) {
          traceMessage({
            event: 'failed',
            senderId,
            receiverId,
            error: `Non-mutual message limit reached: ${currentCount}/${NON_MUTUAL_MESSAGE_LIMIT}`,
          })
          return NextResponse.json({
            error: `你们还不是互相关注，在对方回复前你最多只能发送${NON_MUTUAL_MESSAGE_LIMIT}条消息`,
            error_code: 'PERMISSION_DENIED',
            limit_reached: true,
            sent_count: currentCount
          }, { status: 403 })
        }
      }
    }

    // 获取或创建会话
    const orderedUser1 = senderId < receiverId ? senderId : receiverId
    const orderedUser2 = senderId < receiverId ? receiverId : senderId

    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
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
            .select('*')
            .eq('user1_id', orderedUser1)
            .eq('user2_id', orderedUser2)
            .single()
          conversation = existingConv
        } else {
          logger.error('Create conversation error', { error: convError.message })
          return NextResponse.json({ error: '创建会话失败' }, { status: 500 })
        }
      } else {
        conversation = newConv
      }
    }

    if (!conversation) {
      return NextResponse.json({ error: '无法创建会话' }, { status: 500 })
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
      messageData.media_name = media_name
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
        { error: '服务异常，请稍后重试', error_code: 'SERVER_ERROR' },
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
  } catch (error) {
    logger.error('POST error', { error: String(error) })
    return NextResponse.json(
      { error: '服务异常，请稍后重试', error_code: 'SERVER_ERROR' },
      { status: 500 }
    )
  }
}
