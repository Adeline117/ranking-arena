/**
 * 开始新对话 API
 * POST: 创建或获取与指定用户的会话
 */

import { NextRequest, NextResponse } from 'next/server'
import { traceMessage } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    // 验证用户身份
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: '请先登录', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { receiverId } = body

    // 使用认证用户的 ID 作为发送者
    const senderId = user.id

    if (!receiverId) {
      return NextResponse.json(
        { error: '缺少接收者', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    if (senderId === receiverId) {
      return NextResponse.json(
        { error: '不能给自己发私信', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()

    // 获取接收者的隐私设置
    const { data: receiverProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('dm_permission, handle')
      .eq('id', receiverId)
      .maybeSingle()

    if (profileError || !receiverProfile) {
      return NextResponse.json({ error: '用户不存在' }, { status: 404 })
    }

    // 检查接收者的私信权限设置
    const dmPermission = receiverProfile.dm_permission || 'mutual'

    if (dmPermission === 'none') {
      return NextResponse.json(
        { error: '该用户已关闭私信功能', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    }

    // 检查是否互相关注
    let isMutualFollow = false
    
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

    isMutualFollow = !!senderFollows && !!receiverFollows

    // 如果设置为仅互相关注可以私信，且不是互关
    // 检查是否已经有对话（对方已回复）
    let canMessage = true
    let messageLimit = null

    if (dmPermission === 'mutual' && !isMutualFollow) {
      // 检查是否已有会话
      const orderedUser1 = senderId < receiverId ? senderId : receiverId
      const orderedUser2 = senderId < receiverId ? receiverId : senderId

      const { data: existingConv } = await supabase
        .from('conversations')
        .select('id')
        .eq('user1_id', orderedUser1)
        .eq('user2_id', orderedUser2)
        .maybeSingle()

      if (existingConv) {
        // 检查接收者是否已回复过
        const { data: receiverReplied } = await supabase
          .from('direct_messages')
          .select('id')
          .eq('sender_id', receiverId)
          .eq('receiver_id', senderId)
          .limit(1)
          .maybeSingle()

        if (!receiverReplied) {
          // 检查发送者已发送的消息数量
          const { count: sentCount } = await supabase
            .from('direct_messages')
            .select('*', { count: 'exact', head: true })
            .eq('sender_id', senderId)
            .eq('receiver_id', receiverId)

          const currentCount = sentCount || 0
          if (currentCount >= 3) {
            canMessage = false
            messageLimit = {
              reached: true,
              sent: currentCount,
              max: 3
            }
          } else {
            messageLimit = {
              reached: false,
              sent: currentCount,
              max: 3
            }
          }
        }
      } else {
        // 新会话，限制3条
        messageLimit = {
          reached: false,
          sent: 0,
          max: 3
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
          console.error('[Start Message API] 创建会话错误:', convError)
          return NextResponse.json({ error: '创建会话失败' }, { status: 500 })
        }
      } else {
        conversation = newConv
      }
    }

    if (!conversation) {
      return NextResponse.json({ error: '无法创建会话' }, { status: 500 })
    }

    // 追踪会话创建/获取
    traceMessage({
      event: 'conversation_created',
      conversationId: conversation.id,
      senderId,
      receiverId,
      metadata: { isMutualFollow },
    })

    return NextResponse.json({
      conversation_id: conversation.id,
      can_message: canMessage,
      is_mutual_follow: isMutualFollow,
      message_limit: messageLimit,
      receiver_handle: receiverProfile.handle
    })
  } catch (error) {
    console.error('[Start Message API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


