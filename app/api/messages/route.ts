/**
 * 私信消息 API
 * GET: 获取会话中的消息
 * POST: 发送私信
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

// 非互关用户发送消息的限制数量
const NON_MUTUAL_MESSAGE_LIMIT = 3

// 获取会话消息
export async function GET(request: NextRequest) {
  try {
    const conversationId = request.nextUrl.searchParams.get('conversationId')
    const userId = request.nextUrl.searchParams.get('userId')

    if (!conversationId || !userId) {
      return NextResponse.json({ error: 'Missing conversationId or userId' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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

    // 获取消息列表
    const { data: messages, error: msgError } = await supabase
      .from('direct_messages')
      .select(`
        id,
        sender_id,
        receiver_id,
        content,
        read,
        created_at
      `)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100)

    if (msgError) {
      if (msgError.message?.includes('Could not find')) {
        return NextResponse.json({ messages: [] })
      }
      console.error('[Messages API] 查询错误:', msgError)
      return NextResponse.json({ error: msgError.message }, { status: 500 })
    }

    // 标记接收到的消息为已读
    await supabase
      .from('direct_messages')
      .update({ read: true })
      .eq('conversation_id', conversationId)
      .eq('receiver_id', userId)
      .eq('read', false)

    return NextResponse.json({ messages: messages || [] })
  } catch (error) {
    console.error('[Messages API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 发送私信
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { senderId, receiverId, content } = body

    if (!senderId || !receiverId || !content) {
      return NextResponse.json({ error: 'Missing senderId, receiverId or content' }, { status: 400 })
    }

    if (senderId === receiverId) {
      return NextResponse.json({ error: '不能给自己发私信' }, { status: 400 })
    }

    if (content.trim().length === 0) {
      return NextResponse.json({ error: '消息内容不能为空' }, { status: 400 })
    }

    if (content.length > 2000) {
      return NextResponse.json({ error: '消息内容过长，最多2000字符' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
      return NextResponse.json({ error: '该用户已关闭私信功能' }, { status: 403 })
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
      // 检查接收者是否已回复过
      const { data: receiverReplied, error: replyError } = await supabase
        .from('direct_messages')
        .select('id')
        .eq('sender_id', receiverId)
        .eq('receiver_id', senderId)
        .limit(1)
        .maybeSingle()

      if (replyError && !replyError.message?.includes('Could not find')) {
        console.error('[Messages API] 查询回复错误:', replyError)
      }

      // 如果接收者没有回复过，检查发送者已发送的消息数量
      if (!receiverReplied) {
        const { count: sentCount, error: countError } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('sender_id', senderId)
          .eq('receiver_id', receiverId)

        if (countError && !countError.message?.includes('Could not find')) {
          console.error('[Messages API] 统计消息数错误:', countError)
        }

        const currentCount = sentCount || 0
        if (currentCount >= NON_MUTUAL_MESSAGE_LIMIT) {
          return NextResponse.json({ 
            error: `你们还不是互相关注，在对方回复前你最多只能发送${NON_MUTUAL_MESSAGE_LIMIT}条消息`,
            limit_reached: true,
            sent_count: currentCount
          }, { status: 403 })
        }
      }
    }

    // 获取或创建会话
    // 确保 user1_id < user2_id
    const orderedUser1 = senderId < receiverId ? senderId : receiverId
    const orderedUser2 = senderId < receiverId ? receiverId : senderId

    // 尝试查找现有会话
    let { data: conversation } = await supabase
      .from('conversations')
      .select('*')
      .eq('user1_id', orderedUser1)
      .eq('user2_id', orderedUser2)
      .maybeSingle()

    // 如果会话不存在，创建新会话
    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({ user1_id: orderedUser1, user2_id: orderedUser2 })
        .select()
        .single()

      if (convError) {
        // 如果是并发创建导致的重复，再次查询
        if (convError.code === '23505') {
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('*')
            .eq('user1_id', orderedUser1)
            .eq('user2_id', orderedUser2)
            .single()
          conversation = existingConv
        } else {
          console.error('[Messages API] 创建会话错误:', convError)
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
    const { data: message, error: msgError } = await supabase
      .from('direct_messages')
      .insert({
        conversation_id: conversation.id,
        sender_id: senderId,
        receiver_id: receiverId,
        content: content.trim()
      })
      .select()
      .single()

    if (msgError) {
      console.error('[Messages API] 发送消息错误:', msgError)
      return NextResponse.json({ error: '发送失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message,
      conversation_id: conversation.id
    })
  } catch (error) {
    console.error('[Messages API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

