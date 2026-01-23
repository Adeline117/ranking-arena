'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { getAuthSession, refreshAuthToken } from '@/lib/auth/client'

type MemberSettings = {
  remark: string | null
  is_muted: boolean
  is_pinned: boolean
  is_blocked: boolean
}

type Conversation = {
  id: string
  other_user: {
    id: string
    handle: string | null
    avatar_url?: string | null
    bio?: string | null
  }
  last_message_at: string
  last_message_preview?: string
  unread_count: number
  member_settings?: MemberSettings | null
}

export default function MessagesPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [authChecked, setAuthChecked] = useState(false) // 追踪认证检查是否完成
  const [orphanUnreadCount, setOrphanUnreadCount] = useState(0) // 孤立的未读消息数
  const [clearingOrphans, setClearingOrphans] = useState(false) // 清除孤立消息的loading状态
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // 加载会话列表
  const loadConversations = useCallback(async (uid: string) => {
    try {
      setLoading(true)

      // 获取有效的 auth token
      let auth = await getAuthSession()
      if (!auth) {
        auth = await refreshAuthToken()
        if (!auth) return // 未登录，不加载
      }

      const res = await fetch('/api/conversations', {
        headers: { 'Authorization': `Bearer ${auth.accessToken}` },
      })

      // 如果 401，尝试刷新 token 后重试
      if (res.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          const retryRes = await fetch('/api/conversations', {
            headers: { 'Authorization': `Bearer ${refreshed.accessToken}` },
          })
          const retryData = await retryRes.json()
          if (retryRes.ok && retryData.conversations) {
            setConversations(retryData.conversations)
            return
          }
        }
        return
      }

      const data = await res.json()

      if (data.conversations) {
        setConversations(data.conversations)
        
        // 检查是否有孤立的未读消息（不属于任何会话）
        const conversationUnreadTotal = data.conversations.reduce(
          (sum: number, c: Conversation) => sum + c.unread_count, 0
        )
        
        // 获取总的未读私信数
        const { count: totalUnread } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', uid)
          .eq('read', false)
        
        // 如果总未读数大于会话中的未读数，说明有孤立消息
        const orphanCount = (totalUnread || 0) - conversationUnreadTotal
        setOrphanUnreadCount(orphanCount > 0 ? orphanCount : 0)
      }
    } catch (error) {
      console.error('Error loading conversations:', error)
      showToast('加载会话列表失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  // 监听 auth state 变化，确保在 session 恢复后正确获取用户信息
  useEffect(() => {
    // 首先获取当前 session
    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        setEmail(data.session.user.email ?? null)
        setUserId(data.session.user.id)
        loadConversations(data.session.user.id)
      }
      setAuthChecked(true)
    })

    // 监听 auth 状态变化（处理 session 恢复的情况）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        setEmail(session.user.email ?? null)
        setUserId(session.user.id)
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          loadConversations(session.user.id)
        }
      } else if (event === 'SIGNED_OUT') {
        setUserId(null)
        setEmail(null)
      }
      setAuthChecked(true)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [loadConversations])

  // 订阅实时消息更新
  useEffect(() => {
    if (!userId) return

    // 创建实时订阅通道
    const channel = supabase
      .channel(`messages-list:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${userId}`,
        },
        (payload) => {
          // 收到新消息时，刷新会话列表
          loadConversations(userId)

          // Check if the conversation is muted before showing notification
          const newMsg = payload.new as { conversation_id?: string }
          const conv = conversations.find(c => c.id === newMsg.conversation_id)
          if (!conv?.member_settings?.is_muted) {
            showToast('收到新消息', 'info')
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${userId}`,
        },
        () => {
          // 消息状态更新时（如已读状态），刷新会话列表
          loadConversations(userId)
        }
      )
      .subscribe()

    channelRef.current = channel

    // 清理函数：组件卸载时取消订阅
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [userId, loadConversations, showToast])

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else if (days === 1) {
      return '昨天'
    } else if (days < 7) {
      return `${days}天前`
    } else {
      return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    }
  }

  // 等待认证检查完成
  if (!authChecked || (authChecked && !userId && loading)) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  // 认证检查完成但用户未登录
  if (authChecked && !userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: `${tokens.spacing[5]} ${tokens.spacing[4]}` }}>
          <Box
            style={{ 
              textAlign: 'center',
              padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`,
              background: tokens.colors.bg.secondary,
              borderRadius: 20,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(149, 117, 205, 0.15) 0%, rgba(126, 87, 194, 0.08) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9575cd" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: tokens.colors.text.primary }}>
              请先登录
            </Text>
            <Text size="sm" color="tertiary" style={{ maxWidth: 280, margin: '0 auto', lineHeight: 1.6, marginBottom: tokens.spacing[4] }}>
              登录后可以查看和发送私信
            </Text>
            <a
              href="/login"
              style={{
                display: 'inline-block',
                padding: '12px 24px',
                background: 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)',
                color: '#fff',
                borderRadius: 12,
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: '14px',
              }}
            >
              前往登录
            </a>
          </Box>
        </Box>
      </Box>
    )
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 600, margin: '0 auto', padding: `${tokens.spacing[5]} ${tokens.spacing[4]}` }}>
        {/* 页面标题 */}
        <Box style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[5],
        }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Box style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: 'linear-gradient(135deg, rgba(149, 117, 205, 0.2) 0%, rgba(126, 87, 194, 0.1) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9575cd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </Box>
            <Text size="xl" weight="black">
              私信
            </Text>
          </Box>
          {conversations.length > 0 && (
            <Text size="sm" color="tertiary">
              {conversations.length} 个对话
            </Text>
          )}
        </Box>

        {/* 孤立未读消息提示 */}
        {orphanUnreadCount > 0 && (
          <Box
            style={{
              marginBottom: tokens.spacing[4],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: 'rgba(255, 193, 7, 0.1)',
              border: '1px solid rgba(255, 193, 7, 0.3)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: tokens.spacing[3],
            }}
          >
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text size="sm" color="primary">
                有 {orphanUnreadCount} 条历史未读消息（对话可能已被删除）
              </Text>
            </Box>
            <button
              onClick={async () => {
                if (!userId || clearingOrphans) return
                setClearingOrphans(true)
                try {
                  // 标记所有未读消息为已读
                  await supabase
                    .from('direct_messages')
                    .update({ read: true })
                    .eq('receiver_id', userId)
                    .eq('read', false)
                  setOrphanUnreadCount(0)
                  showToast('已清除', 'success')
                } catch {
                  showToast('清除失败', 'error')
                } finally {
                  setClearingOrphans(false)
                }
              }}
              disabled={clearingOrphans}
              style={{
                padding: '6px 12px',
                background: 'rgba(255, 193, 7, 0.2)',
                border: '1px solid rgba(255, 193, 7, 0.4)',
                borderRadius: 8,
                color: tokens.colors.text.primary,
                fontSize: 13,
                fontWeight: 600,
                cursor: clearingOrphans ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                opacity: clearingOrphans ? 0.6 : 1,
                transition: 'opacity 0.2s',
              }}
            >
              {clearingOrphans ? '清除中...' : '全部清除'}
            </button>
          </Box>
        )}

        {conversations.length === 0 && orphanUnreadCount === 0 ? (
          <Box
            style={{ 
              textAlign: 'center',
              padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`,
              background: tokens.colors.bg.secondary,
              borderRadius: 20,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(149, 117, 205, 0.15) 0%, rgba(126, 87, 194, 0.08) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[4],
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9575cd" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                <line x1="9" y1="10" x2="15" y2="10"/>
              </svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: tokens.colors.text.primary }}>
              暂无私信
            </Text>
            <Text size="sm" color="tertiary" style={{ maxWidth: 280, margin: '0 auto', lineHeight: 1.6, marginBottom: tokens.spacing[4] }}>
              访问用户主页点击「私信」按钮，开始与其他用户交流
            </Text>
            <Link
              href="/search?type=users"
              style={{
                display: 'inline-block',
                padding: '12px 20px',
                background: 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)',
                color: '#fff',
                borderRadius: 12,
                textDecoration: 'none',
                fontWeight: 700,
                fontSize: '14px',
              }}
            >
              搜索用户发起对话
            </Link>
          </Box>
        ) : conversations.length > 0 ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {conversations.map((conv, index) => (
              <Link
                key={conv.id}
                href={`/messages/${conv.id}`}
                style={{ textDecoration: 'none' }}
              >
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    background: conv.unread_count > 0 
                      ? 'rgba(149, 117, 205, 0.08)' 
                      : 'transparent',
                    borderRadius: index === 0 ? '16px 16px 4px 4px' 
                      : index === conversations.length - 1 ? '4px 4px 16px 16px' 
                      : '4px',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    border: `1px solid ${conv.unread_count > 0 ? 'rgba(149, 117, 205, 0.2)' : tokens.colors.border.primary}`,
                    marginBottom: -1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.secondary
                    e.currentTarget.style.transform = 'translateX(4px)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = conv.unread_count > 0 
                      ? 'rgba(149, 117, 205, 0.08)' 
                      : 'transparent'
                    e.currentTarget.style.transform = 'translateX(0)'
                  }}
                >
                  {/* 头像区域 */}
                  <Box style={{ position: 'relative', flexShrink: 0 }}>
                    <Avatar
                      userId={conv.other_user.id}
                      name={conv.other_user.handle || `User ${conv.other_user.id.slice(0, 8)}`}
                      avatarUrl={conv.other_user.avatar_url}
                      size={52}
                    />
                    {/* 未读标记点 */}
                    {conv.unread_count > 0 && (
                      <Box style={{
                        position: 'absolute',
                        top: 0,
                        right: 0,
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)',
                        border: `2px solid ${tokens.colors.bg.primary}`,
                      }} />
                    )}
                  </Box>
                  
                  {/* 内容区域 */}
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Box style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 4,
                    }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        {/* Pin icon */}
                        {conv.member_settings?.is_pinned && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="#9575cd" stroke="#9575cd" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <line x1="12" y1="17" x2="12" y2="22" />
                            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z" />
                          </svg>
                        )}
                        <Text
                          size="base"
                          weight={conv.unread_count > 0 ? 'black' : 'bold'}
                          style={{
                            color: tokens.colors.text.primary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {conv.member_settings?.remark || conv.other_user.handle || `User ${conv.other_user.id.slice(0, 8)}`}
                        </Text>
                        {/* Mute icon */}
                        {conv.member_settings?.is_muted && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" style={{ flexShrink: 0 }}>
                            <path d="M11 5L6 9H2v6h4l5 4V5z" />
                            <line x1="23" y1="9" x2="17" y2="15" />
                            <line x1="17" y1="9" x2="23" y2="15" />
                          </svg>
                        )}
                      </Box>
                      <Text size="xs" color="tertiary" style={{ flexShrink: 0, marginLeft: 8 }}>
                        {formatTime(conv.last_message_at)}
                      </Text>
                    </Box>
                    <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Text
                        size="sm"
                        color={conv.unread_count > 0 ? 'primary' : 'secondary'}
                        weight={conv.unread_count > 0 ? 'semibold' : 'normal'}
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                        }}
                      >
                        {conv.last_message_preview || '开始聊天'}
                      </Text>
                      {conv.unread_count > 0 && !conv.member_settings?.is_muted && (
                        <Box
                          style={{
                            background: 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)',
                            color: '#fff',
                            borderRadius: 10,
                            minWidth: 20,
                            height: 20,
                            padding: '0 6px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {conv.unread_count > 99 ? '99+' : conv.unread_count}
                        </Box>
                      )}
                      {conv.unread_count > 0 && conv.member_settings?.is_muted && (
                        <Box
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: tokens.colors.text.tertiary,
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </Box>
                  </Box>
                  
                  {/* 箭头指示 */}
                  <Box style={{ 
                    color: tokens.colors.text.tertiary,
                    opacity: 0.5,
                    flexShrink: 0,
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 18l6-6-6-6"/>
                    </svg>
                  </Box>
                </Box>
              </Link>
            ))}
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

