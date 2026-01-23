/**
 * 会话列表 API
 * GET: 获取当前用户的所有会话
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export async function GET(request: NextRequest) {
  try {
    const userId = request.nextUrl.searchParams.get('userId')

    if (!userId) {
      return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
    const enhancedConversations = await Promise.all(
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
          created_at: conv.created_at
        }
      })
    )

    return NextResponse.json({ conversations: enhancedConversations })
  } catch (error) {
    console.error('[Conversations API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
