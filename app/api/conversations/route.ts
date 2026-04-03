/**
 * 会话列表 API
 * GET: 获取当前用户的所有会话（需要认证）
 *
 * SECURITY: Uses withAuth middleware which derives userId from authenticated session,
 * preventing users from accessing other users' conversation lists.
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
    const conversationIds = conversations.map(c => c.id)

    const [profilesResult, unreadResult, memberSettingsResult] = await Promise.all([
      // 一次性获取所有对方用户资料
      supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, bio')
        .in('id', uniqueOtherUserIds),
      // 一次性获取所有会话的未读计数（排除已删除消息）
      supabase
        .from('direct_messages')
        .select('conversation_id', { count: 'exact' })
        .eq('receiver_id', userId)
        .eq('read', false)
        .is('deleted_at', null)
        .in('conversation_id', conversationIds),
      // 一次性获取所有会话的成员设置（备注、置顶、静音等）
      supabase
        .from('conversation_members')
        .select('conversation_id, remark, is_muted, is_pinned, is_blocked')
        .eq('user_id', userId)
        .in('conversation_id', conversationIds),
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

    // 构建成员设置映射
    const memberSettingsMap = new Map<string, { remark: string | null; is_muted: boolean; is_pinned: boolean; is_blocked: boolean }>()
    if (memberSettingsResult.data) {
      for (const setting of memberSettingsResult.data) {
        memberSettingsMap.set(setting.conversation_id, {
          remark: setting.remark || null,
          is_muted: setting.is_muted || false,
          is_pinned: setting.is_pinned || false,
          is_blocked: setting.is_blocked || false,
        })
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
        member_settings: memberSettingsMap.get(conv.id) || null,
      }
    })

    // Sort: pinned conversations first, then by last_message_at
    enhancedConversations.sort((a, b) => {
      const aPinned = a.member_settings?.is_pinned || false
      const bPinned = b.member_settings?.is_pinned || false
      if (aPinned && !bPinned) return -1
      if (!aPinned && bPinned) return 1
      return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
    })

    return NextResponse.json({ conversations: enhancedConversations })
  },
  { rateLimit: 'authenticated', name: 'conversations' }
)
