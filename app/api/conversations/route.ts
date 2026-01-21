/**
 * 会话列表 API
 * GET: 获取当前用户的所有会话
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * 验证用户身份并返回用户ID
 */
async function authenticateUser(request: NextRequest, supabase: ReturnType<typeof createClient>): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: '未授权：缺少认证令牌', status: 401 }
  }

  const token = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return { error: '身份验证失败', status: 401 }
  }

  return { userId: user.id }
}

export async function GET(request: NextRequest) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    // 验证用户身份
    const authResult = await authenticateUser(request, supabase)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    const userId = authResult.userId

    // 获取用户的所有会话
    const { data: conversations, error } = await supabase
      .from('conversations')
      .select(`
        id,
        user1_id,
        user2_id,
        last_message_at,
        last_message_preview,
        created_at
      `)
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('last_message_at', { ascending: false })
      .limit(50)

    if (error) {
      if (error.message?.includes('Could not find')) {
        return NextResponse.json({ conversations: [] })
      }
      console.error('[Conversations API] 查询错误:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 获取每个会话中另一方用户的信息和未读消息数
    // 使用 Promise.allSettled 确保单个查询失败不会导致整个列表失败
    const enhancedResults = await Promise.allSettled(
      (conversations || []).map(async (conv: any) => {
        const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id

        // 获取另一方用户信息
        const { data: otherUser } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url, bio')
          .eq('id', otherUserId)
          .maybeSingle()

        // 获取未读消息数
        const { count: unreadCount } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .eq('receiver_id', userId)
          .eq('read', false)

        return {
          id: conv.id,
          other_user: otherUser || { id: otherUserId, handle: '未知用户', avatar_url: null, bio: null },
          last_message_at: conv.last_message_at,
          last_message_preview: conv.last_message_preview,
          unread_count: unreadCount || 0,
          created_at: conv.created_at
        }
      })
    )

    // 过滤出成功的结果，记录失败的
    const enhancedConversations = enhancedResults
      .filter((result): result is PromiseFulfilledResult<any> => {
        if (result.status === 'rejected') {
          console.error('[Conversations API] 增强会话数据失败:', result.reason)
          return false
        }
        return true
      })
      .map(result => result.value)

    return NextResponse.json({ conversations: enhancedConversations })
  } catch (error) {
    console.error('[Conversations API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
