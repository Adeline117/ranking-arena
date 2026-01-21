'use client'

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'
import { useToast } from '@/app/components/UI/Toast'
import { getCsrfHeaders } from '@/lib/api/client'

type Message = {
  id: string
  sender_id: string
  receiver_id: string
  content: string
  read: boolean
  created_at: string
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

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
      const res = await fetch(`/api/messages?conversationId=${convId}&userId=${uid}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      })
      const data = await res.json()
      
      if (data.error) {
        showToast(data.error, 'error')
        router.push('/messages')
        return
      }
      
      if (data.messages) {
        setMessages(data.messages)
        
        // 使用 API 返回的对方用户信息
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

  // 订阅实时消息更新
  useEffect(() => {
    if (!userId || !conversationId || !otherUser) return

    // 创建实时订阅通道 - 监听来自对方的新消息
    const channel = supabase
      .channel(`conversation:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          filter: `sender_id=eq.${otherUser.id}`,
        },
        (payload) => {
          // 检查这条消息是否是发给当前用户的
          const newMsg = payload.new as Message
          if (newMsg.receiver_id === userId) {
            // 添加新消息到列表（避免重复）
            setMessages(prev => {
              if (prev.some(m => m.id === newMsg.id)) {
                return prev
              }
              return [...prev, newMsg]
            })
          }
        }
      )
      .subscribe()

    channelRef.current = channel

    // 清理函数
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
  }, [userId, conversationId, otherUser])

  const handleSend = async () => {
    if (!newMessage.trim() || !userId || !otherUser || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          senderId: userId,
          receiverId: otherUser.id,
          content: newMessage.trim()
        })
      })
      
      const data = await res.json()
      
      if (!res.ok) {
        showToast(data.error || '发送失败', 'error')
        return
      }
      
      if (data.message) {
        setMessages(prev => [...prev, data.message])
        setNewMessage('')
        inputRef.current?.focus()
      }
    } catch (error) {
      console.error('Error sending message:', error)
      showToast('发送失败', 'error')
    } finally {
      setSending(false)
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
              {/* 在线状态指示器（可选） */}
              <Box style={{
                position: 'absolute',
                bottom: 1,
                right: 1,
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#4caf50',
                border: `2px solid ${tokens.colors.bg.secondary}`,
              }} />
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

      {/* Messages Area */}
      <Box style={{ 
        flex: 1, 
        overflow: 'auto',
        padding: tokens.spacing[4],
        maxWidth: 800,
        margin: '0 auto',
        width: '100%'
      }}>
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
                        ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)' 
                        : tokens.colors.bg.secondary,
                      color: isMine ? '#fff' : tokens.colors.text.primary,
                      border: isMine ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                      boxShadow: isMine 
                        ? '0 1px 2px rgba(126, 87, 194, 0.2)' 
                        : '0 1px 2px rgba(0,0,0,0.05)',
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
                  
                  {/* 时间戳 - 放在气泡外面下方 */}
                  {showTime && (
                    <Text 
                      size="xs" 
                      color="tertiary"
                      style={{ 
                        marginTop: 4,
                        paddingLeft: isMine ? 0 : 4,
                        paddingRight: isMine ? 4 : 0,
                        fontSize: 11,
                      }}
                    >
                      {formatTime(msg.created_at)}
                      {isMine && msg.read && (
                        <span style={{ marginLeft: 4, opacity: 0.7 }}>✓</span>
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
            disabled={!newMessage.trim() || sending}
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: 'none',
              background: newMessage.trim() 
                ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)' 
                : tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)',
              color: newMessage.trim() ? '#fff' : tokens.colors.text.tertiary,
              cursor: newMessage.trim() && !sending ? 'pointer' : 'default',
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

