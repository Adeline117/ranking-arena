/**
 * 会话列表 API
 * GET: 获取当前用户的所有会话（需要认证）
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'

export const GET = withAuth(
  async ({ user, supabase }) => {
    const userId = user.id

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
      return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 })
    }

    if (!conversations || conversations.length === 0) {
      return NextResponse.json({ conversations: [] })
    }

    // 批量获取对方用户信息（避免 N+1 查询）
    const otherUserIds = conversations.map(conv =>
      conv.user1_id === userId ? conv.user2_id : conv.user1_id
    )
    const uniqueOtherUserIds = [...new Set(otherUserIds)]

    const [profilesResult, unreadResult] = await Promise.all([
      // 一次性获取所有对方用户资料
      supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, bio')
        .in('id', uniqueOtherUserIds),
      // 一次性获取所有会话的未读计数
      supabase
        .from('direct_messages')
        .select('conversation_id', { count: 'exact' })
        .eq('receiver_id', userId)
        .eq('read', false)
        .in('conversation_id', conversations.map(c => c.id)),
    ])

    // 构建用户资料映射
    const profileMap = new Map<string, { id: string; handle: string | null; avatar_url: string | null; bio: string | null }>()
    profilesResult.data?.forEach(p => {
      profileMap.set(p.id, {
        id: p.id,
        handle: p.handle || null,
        avatar_url: p.avatar_url || null,
        bio: p.bio || null,
      })
    })

    // 构建未读计数映射（按 conversation_id 分组）
    const unreadMap = new Map<string, number>()
    if (unreadResult.data) {
      for (const msg of unreadResult.data) {
        const convId = msg.conversation_id
        unreadMap.set(convId, (unreadMap.get(convId) || 0) + 1)
      }
    }

    // 组装结果
    const enhancedConversations = conversations.map(conv => {
      const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id
      const otherUser = profileMap.get(otherUserId)

      return {
        id: conv.id,
        other_user: otherUser || {
          id: otherUserId,
          handle: null,
          avatar_url: null,
          bio: null,
        },
        last_message_at: conv.last_message_at,
        last_message_preview: conv.last_message_preview,
        unread_count: unreadMap.get(conv.id) || 0,
        created_at: conv.created_at,
      }
    })

    return NextResponse.json({ conversations: enhancedConversations })
  },
  { rateLimit: 'authenticated', name: 'conversations' }
)
