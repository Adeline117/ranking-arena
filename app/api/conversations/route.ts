/**
 * 会话列表 API
 * GET: 获取当前用户的所有会话
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    // 验证用户身份
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: '请先登录', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const userId = user.id // 使用认证用户的 ID

    const supabase = getSupabaseAdmin()

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

    // 获取每个会话中另一方用户的信息、未读消息数和成员设置
    const enhancedConversations = await Promise.all(
      (conversations || []).map(async (conv: { id: string; user1_id: string; user2_id: string; last_message_at: string; last_message_preview: string | null; created_at: string }) => {
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

        // 获取成员设置（备注、置顶、静音等）
        const { data: memberSettings } = await supabase
          .from('conversation_members')
          .select('remark, is_muted, is_pinned, is_blocked')
          .eq('conversation_id', conv.id)
          .eq('user_id', userId)
          .maybeSingle()

        return {
          id: conv.id,
          other_user: otherUser
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
              },
          last_message_at: conv.last_message_at,
          last_message_preview: conv.last_message_preview,
          unread_count: unreadCount || 0,
          created_at: conv.created_at,
          member_settings: memberSettings || null,
        }
      })
    )

    // Sort: pinned conversations first, then by last_message_at
    enhancedConversations.sort((a, b) => {
      const aPinned = a.member_settings?.is_pinned || false
      const bPinned = b.member_settings?.is_pinned || false
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    })

    return NextResponse.json({ conversations: enhancedConversations })
  } catch (error) {
    console.error('[Conversations API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
