'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useRealtime } from '@/lib/hooks/useRealtime'

type MessageStatus = 'sending' | 'sent' | 'failed'

type Message = {
  id: string
  sender_id: string
  receiver_id: string
  content: string
  read: boolean
  created_at: string
  _status?: MessageStatus // client-side only: optimistic UI state
  _tempId?: string // client-side only: temporary ID before server confirms
}

type OtherUser = {
  id: string
  handle: string
  avatar_url?: string
  bio?: string
}

export default function ConversationPage({ params }: { params: { conversationId: string } | Promise<{ conversationId: string }> }) {
  const router = useRouter()
  const { showToast } = useToast()
  const [conversationId, setConversationId] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null) // 添加 access token
  const [authChecked, setAuthChecked] = useState(false) // 追踪认证检查是否完成
  const [messages, setMessages] = useState<Message[]>([])
  const [otherUser, setOtherUser] = useState<OtherUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('connected')
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 注入 spin 动画样式
  useEffect(() => {
    if (typeof document === 'undefined') return
    const styleId = 'spin-animation-style'
    if (document.getElementById(styleId)) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }'
    document.head.appendChild(style)
  }, [])

  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ conversationId: string }>).then(resolved => {
        setConversationId(resolved.conversationId)
      })
    } else {
      setConversationId(String((params as { conversationId: string })?.conversationId ?? ''))
    }
  }, [params])

  // 使用 getSession 代替 getUser，更可靠地检查认证状态
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null) // 保存 access token
      setAuthChecked(true) // 认证检查完成
      
      if (data.session?.user?.id && data.session?.access_token && conversationId) {
        loadMessages(data.session.user.id, conversationId, data.session.access_token)
      }
    })
  }, [conversationId])

  // 滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const loadMessages = useCallback(async (uid: string, convId: string, token?: string) => {
    try {
      setLoading(true)
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      const res = await fetch(`/api/messages?conversationId=${convId}`, { headers })
      const data = await res.json()

      if (data.error) {
        showToast(data.error, 'error')
        router.push('/messages')
        return
      }

      if (data.messages) {
        setMessages(data.messages)
        setHasMore(!!data.has_more)

        if (data.otherUser) {
          setOtherUser(data.otherUser)
        }
      }
    } catch (error) {
      console.error('Error loading messages:', error)
      showToast('加载消息失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast, router])

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || !accessToken || loadingMore || !hasMore) return
    const oldest = messages.find(m => !m._tempId)
    if (!oldest) return

    setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/messages?conversationId=${conversationId}&before=${oldest.created_at}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      )
      const data = await res.json()

      if (data.messages?.length) {
        setMessages(prev => [...data.messages, ...prev])
        setHasMore(!!data.has_more)
      } else {
        setHasMore(false)
      }
    } catch {
      showToast('加载历史消息失败', 'error')
    } finally {
      setLoadingMore(false)
    }
  }, [conversationId, accessToken, loadingMore, hasMore, messages, showToast])

  // 订阅实时消息更新（使用 useRealtime hook 获得自动重连能力）
  useRealtime<Message>({
    table: 'direct_messages',
    event: 'INSERT',
    filter: otherUser ? `sender_id=eq.${otherUser.id}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true,
    maxRetries: 10,
    onInsert: (newMsg) => {
      if (newMsg.receiver_id === userId) {
        setMessages(prev => {
          if (prev.some(m => m.id === newMsg.id)) return prev
          return [...prev, newMsg]
        })
      }
    },
    onStatusChange: (status) => {
      if (status === 'connected') {
        setConnectionStatus('connected')
      } else if (status === 'disconnected' || status === 'error') {
        setConnectionStatus('disconnected')
      } else if (status === 'reconnecting') {
        setConnectionStatus('reconnecting')
      }
    },
  })

  const handleSend = async () => {
    if (!newMessage.trim() || !userId || !otherUser || sending) return

    const content = newMessage.trim()
    if (content.length > 2000) {
      showToast('消息内容过长，最多2000字符', 'warning')
      return
    }

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticMessage: Message = {
      id: tempId,
      sender_id: userId,
      receiver_id: otherUser.id,
      content,
      read: false,
      created_at: new Date().toISOString(),
      _status: 'sending',
      _tempId: tempId,
    }

    // Optimistic: show message immediately
    setMessages(prev => [...prev, optimisticMessage])
    setNewMessage('')
    inputRef.current?.focus()

    setSending(true)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getCsrfHeaders()
      }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const res = await fetch('/api/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          receiverId: otherUser.id,
          content
        })
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => prev.map(m =>
          m._tempId === tempId ? { ...m, _status: 'failed' as MessageStatus } : m
        ))
        showToast(data.error || '发送失败', 'error')
        return
      }

      if (data.message) {
        setMessages(prev => prev.map(m =>
          m._tempId === tempId ? { ...data.message, _status: 'sent' as MessageStatus } : m
        ))
      }
    } catch (error) {
      console.error('Error sending message:', error)
      setMessages(prev => prev.map(m =>
        m._tempId === tempId ? { ...m, _status: 'failed' as MessageStatus } : m
      ))
      showToast('发送失败，点击消息重试', 'error')
    } finally {
      setSending(false)
    }
  }

  const handleRetry = async (failedMsg: Message) => {
    if (!userId || !otherUser) return

    setMessages(prev => prev.map(m =>
      m.id === failedMsg.id ? { ...m, _status: 'sending' as MessageStatus } : m
    ))

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getCsrfHeaders()
      }
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

      const res = await fetch('/api/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          receiverId: otherUser.id,
          content: failedMsg.content
        })
      })

      const data = await res.json()

      if (!res.ok) {
        setMessages(prev => prev.map(m =>
          m.id === failedMsg.id ? { ...m, _status: 'failed' as MessageStatus } : m
        ))
        showToast(data.error || '重试失败', 'error')
        return
      }

      if (data.message) {
        setMessages(prev => prev.map(m =>
          m.id === failedMsg.id ? { ...data.message, _status: 'sent' as MessageStatus } : m
        ))
      }
    } catch {
      setMessages(prev => prev.map(m =>
        m.id === failedMsg.id ? { ...m, _status: 'failed' as MessageStatus } : m
      ))
      showToast('重试失败', 'error')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleTimeString('zh-CN', { 
      hour: '2-digit', 
      minute: '2-digit' 
    })
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    
    if (date.toDateString() === today.toDateString()) {
      return '今天'
    } else if (date.toDateString() === yesterday.toDateString()) {
      return '昨天'
    } else {
      return date.toLocaleDateString('zh-CN', { 
        month: 'long', 
        day: 'numeric' 
      })
    }
  }

  // 按日期分组消息
  const groupMessagesByDate = (msgs: Message[]) => {
    const groups: { date: string; messages: Message[] }[] = []
    let currentDate = ''
    
    msgs.forEach(msg => {
      const msgDate = new Date(msg.created_at).toDateString()
      if (msgDate !== currentDate) {
        currentDate = msgDate
        groups.push({ date: msg.created_at, messages: [msg] })
      } else {
        groups[groups.length - 1].messages.push(msg)
      }
    })
    
    return groups
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

  const messageGroups = groupMessagesByDate(messages)

  return (
    <Box style={{ 
      minHeight: '100vh', 
      background: tokens.colors.bg.primary, 
      color: tokens.colors.text.primary,
      display: 'flex',
      flexDirection: 'column'
    }}>
      <TopNav email={email} />
      
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          backdropFilter: 'blur(8px)',
        }}
      >
        <Link 
          href="/messages" 
          style={{ 
            color: tokens.colors.text.secondary, 
            textDecoration: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: tokens.radius.full,
            transition: 'all 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)'
            e.currentTarget.style.color = tokens.colors.text.primary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = tokens.colors.text.secondary
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
        </Link>
        
        {otherUser && (
          <Link 
            href={`/u/${otherUser.handle}`} 
            style={{ 
              textDecoration: 'none', 
              display: 'flex', 
              alignItems: 'center', 
              gap: tokens.spacing[3],
              flex: 1,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              transition: 'background 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary || 'rgba(255,255,255,0.05)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <Box style={{ position: 'relative' }}>
              <Avatar
                userId={otherUser.id}
                name={otherUser.handle}
                avatarUrl={otherUser.avatar_url}
                size={44}
              />
            </Box>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>
                {otherUser.handle}
              </Text>
              {otherUser.bio && (
                <Text size="xs" color="tertiary" style={{ 
                  maxWidth: '100%', 
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis', 
                  whiteSpace: 'nowrap',
                  marginTop: 2,
                }}>
                  {otherUser.bio}
                </Text>
              )}
            </Box>
          </Link>
        )}
      </Box>

      {/* Connection status banner */}
      {connectionStatus !== 'connected' && (
        <Box style={{
          padding: '6px 16px',
          background: connectionStatus === 'reconnecting' ? 'rgba(255, 152, 0, 0.15)' : 'rgba(244, 67, 54, 0.15)',
          color: connectionStatus === 'reconnecting' ? '#ff9800' : '#f44336',
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {connectionStatus === 'reconnecting' ? '正在重新连接...' : '连接已断开，新消息可能延迟'}
        </Box>
      )}

      {/* Messages Area */}
      <Box style={{
        flex: 1,
        overflow: 'auto',
        padding: tokens.spacing[4],
        maxWidth: 800,
        margin: '0 auto',
        width: '100%'
      }}>
        {/* Load older messages */}
        {hasMore && (
          <Box style={{ textAlign: 'center', marginBottom: 12 }}>
            <button
              onClick={loadOlderMessages}
              disabled={loadingMore}
              style={{
                padding: '6px 16px',
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: 16,
                color: tokens.colors.text.secondary,
                fontSize: 13,
                cursor: loadingMore ? 'not-allowed' : 'pointer',
                opacity: loadingMore ? 0.6 : 1,
                transition: 'opacity 0.2s',
              }}
            >
              {loadingMore ? '加载中...' : '加载更早的消息'}
            </button>
          </Box>
        )}

        {messageGroups.map((group, groupIndex) => (
          <Box key={groupIndex}>
            {/* Date Divider */}
            <Box style={{ 
              textAlign: 'center', 
              margin: `${tokens.spacing[5]} 0`,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: tokens.spacing[3],
            }}>
              <Box style={{ 
                flex: 1, 
                height: 1, 
                background: `linear-gradient(to right, transparent, ${tokens.colors.border.primary})`,
                maxWidth: 80,
              }} />
              <Text
                size="xs"
                color="tertiary"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.5px',
                  fontWeight: 600,
                }}
              >
                {formatDate(group.date)}
              </Text>
              <Box style={{ 
                flex: 1, 
                height: 1, 
                background: `linear-gradient(to left, transparent, ${tokens.colors.border.primary})`,
                maxWidth: 80,
              }} />
            </Box>
            
            {/* Messages */}
            {group.messages.map((msg, msgIndex) => {
              const isMine = msg.sender_id === userId
              const prevMsg = msgIndex > 0 ? group.messages[msgIndex - 1] : null
              const nextMsg = msgIndex < group.messages.length - 1 ? group.messages[msgIndex + 1] : null
              const isSameSenderAsPrev = prevMsg?.sender_id === msg.sender_id
              const isSameSenderAsNext = nextMsg?.sender_id === msg.sender_id
              
              // 计算是否显示时间（最后一条消息或下一条是不同发送者时显示）
              const showTime = !isSameSenderAsNext
              
              return (
                <Box
                  key={msg.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isMine ? 'flex-end' : 'flex-start',
                    marginBottom: isSameSenderAsNext ? '2px' : tokens.spacing[3],
                  }}
                >
                  {/* 气泡 */}
                  <Box
                    style={{
                      maxWidth: '75%',
                      minWidth: 48,
                      padding: '10px 14px',
                      borderRadius: isMine
                        ? isSameSenderAsPrev && isSameSenderAsNext
                          ? '18px 6px 6px 18px'  // 中间
                          : isSameSenderAsPrev
                            ? '18px 6px 18px 18px' // 最后
                            : isSameSenderAsNext
                              ? '18px 18px 6px 18px' // 第一条
                              : '18px' // 单独一条
                        : isSameSenderAsPrev && isSameSenderAsNext
                          ? '6px 18px 18px 6px'  // 中间
                          : isSameSenderAsPrev
                            ? '6px 18px 18px 18px' // 最后
                            : isSameSenderAsNext
                              ? '18px 18px 18px 6px' // 第一条
                              : '18px', // 单独一条
                      background: isMine
                        ? msg._status === 'failed'
                          ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)'
                          : 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)'
                        : tokens.colors.bg.secondary,
                      color: isMine ? '#fff' : tokens.colors.text.primary,
                      border: isMine
                        ? msg._status === 'failed'
                          ? '1px solid rgba(244, 67, 54, 0.6)'
                          : 'none'
                        : `1px solid ${tokens.colors.border.primary}`,
                      boxShadow: isMine
                        ? '0 1px 2px rgba(126, 87, 194, 0.2)'
                        : '0 1px 2px rgba(0,0,0,0.05)',
                      opacity: msg._status === 'sending' ? 0.7 : 1,
                      transition: 'opacity 0.2s',
                    }}
                  >
                    <Text 
                      size="sm" 
                      style={{ 
                        whiteSpace: 'pre-wrap', 
                        wordBreak: 'break-word',
                        lineHeight: 1.5,
                      }}
                    >
                      {msg.content}
                    </Text>
                  </Box>
                  
                  {/* Failed state: retry button */}
                  {isMine && msg._status === 'failed' && (
                    <button
                      onClick={() => handleRetry(msg)}
                      style={{
                        marginTop: 4,
                        padding: '2px 8px',
                        background: 'rgba(244, 67, 54, 0.15)',
                        border: '1px solid rgba(244, 67, 54, 0.4)',
                        borderRadius: 6,
                        color: '#f44336',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 4v6h6M23 20v-6h-6"/>
                        <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                      </svg>
                      发送失败，点击重试
                    </button>
                  )}

                  {/* 时间戳 + 状态指示器 */}
                  {showTime && msg._status !== 'failed' && (
                    <Text
                      size="xs"
                      color="tertiary"
                      style={{
                        marginTop: 4,
                        paddingLeft: isMine ? 0 : 4,
                        paddingRight: isMine ? 4 : 0,
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                      }}
                    >
                      {msg._status === 'sending' ? (
                        <span style={{ opacity: 0.6 }}>发送中...</span>
                      ) : (
                        <>
                          {formatTime(msg.created_at)}
                          {isMine && (
                            <span style={{ marginLeft: 2, opacity: 0.7 }}>
                              {msg.read ? '✓✓' : '✓'}
                            </span>
                          )}
                        </>
                      )}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
        ))}
        
        {messages.length === 0 && (
          <Box style={{ 
            textAlign: 'center', 
            padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}>
            <Box style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(149, 117, 205, 0.2) 0%, rgba(126, 87, 194, 0.1) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9575cd" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </Box>
            <Box>
              <Text size="base" weight="bold" style={{ marginBottom: 4, color: tokens.colors.text.primary }}>
                开始对话
              </Text>
              <Text size="sm" color="tertiary">
                向 @{otherUser?.handle} 发送第一条消息
              </Text>
            </Box>
          </Box>
        )}
        
        <div ref={messagesEndRef} />
      </Box>

      {/* Input Area */}
      <Box
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        {/* Character counter - show when approaching limit */}
        {newMessage.length > 1800 && (
          <Box style={{
            maxWidth: 800,
            margin: '0 auto',
            marginBottom: 4,
            textAlign: 'right',
            paddingRight: 8,
          }}>
            <Text size="xs" style={{
              color: newMessage.length > 2000 ? '#f44336' : newMessage.length > 1900 ? '#ff9800' : tokens.colors.text.tertiary,
              fontSize: 11,
              fontWeight: newMessage.length > 2000 ? 700 : 400,
            }}>
              {newMessage.length}/2000
            </Text>
          </Box>
        )}
        <Box style={{ 
          maxWidth: 800, 
          margin: '0 auto',
          display: 'flex',
          gap: tokens.spacing[2],
          alignItems: 'flex-end',
          background: tokens.colors.bg.primary,
          borderRadius: 24,
          padding: '6px 6px 6px 16px',
          border: `1px solid ${tokens.colors.border.primary}`,
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}>
          <textarea
            ref={inputRef}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            rows={1}
            style={{
              flex: 1,
              padding: '8px 0',
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              resize: 'none',
              minHeight: 24,
              maxHeight: 100,
              lineHeight: 1.5,
            }}
            onFocus={(e) => {
              const container = e.currentTarget.parentElement
              if (container) {
                container.style.borderColor = '#9575cd'
                container.style.boxShadow = '0 0 0 2px rgba(149, 117, 205, 0.2)'
              }
            }}
            onBlur={(e) => {
              const container = e.currentTarget.parentElement
              if (container) {
                container.style.borderColor = tokens.colors.border.primary
                container.style.boxShadow = 'none'
              }
            }}
          />
          <button
            onClick={handleSend}
            disabled={!newMessage.trim() || sending || newMessage.length > 2000}
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: 'none',
              background: newMessage.trim() && newMessage.length <= 2000
                ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)'
                : tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)',
              color: newMessage.trim() && newMessage.length <= 2000 ? '#fff' : tokens.colors.text.tertiary,
              cursor: newMessage.trim() && !sending && newMessage.length <= 2000 ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
              flexShrink: 0,
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? (
              <Box style={{
                width: 18,
                height: 18,
                border: '2px solid currentColor',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            )}
          </button>
        </Box>
      </Box>
    </Box>
  )
}

