'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'
import { useToast } from '@/app/components/UI/Toast'

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
  const [messages, setMessages] = useState<Message[]>([])
  const [otherUser, setOtherUser] = useState<OtherUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ conversationId: string }>).then(resolved => {
        setConversationId(resolved.conversationId)
      })
    } else {
      setConversationId(String((params as { conversationId: string })?.conversationId ?? ''))
    }
  }, [params])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (!data.user) {
        router.push('/login')
        return
      }
      
      if (conversationId) {
        loadMessages(data.user.id, conversationId)
      }
    })
  }, [router, conversationId])

  // 滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const loadMessages = async (uid: string, convId: string) => {
    try {
      setLoading(true)
      const res = await fetch(`/api/messages?conversationId=${convId}&userId=${uid}`)
      const data = await res.json()
      
      if (data.error) {
        showToast(data.error, 'error')
        router.push('/messages')
        return
      }
      
      if (data.messages) {
        setMessages(data.messages)
        
        // 获取对方用户信息
        if (data.messages.length > 0) {
          const otherUserId = data.messages[0].sender_id === uid 
            ? data.messages[0].receiver_id 
            : data.messages[0].sender_id
          
          const { data: userData } = await supabase
            .from('user_profiles')
            .select('id, handle, avatar_url, bio')
            .eq('id', otherUserId)
            .maybeSingle()
          
          if (userData) {
            setOtherUser(userData)
          }
        } else {
          // 如果没有消息，从会话信息获取对方用户
          const convRes = await fetch(`/api/conversations?userId=${uid}`)
          const convData = await convRes.json()
          const conv = convData.conversations?.find((c: any) => c.id === convId)
          if (conv?.other_user) {
            setOtherUser(conv.other_user)
          }
        }
      }
    } catch (error) {
      console.error('Error loading messages:', error)
      showToast('加载消息失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleSend = async () => {
    if (!newMessage.trim() || !userId || !otherUser || sending) return

    setSending(true)
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        bg="secondary"
        p={4}
        border="primary"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          borderLeft: 'none',
          borderRight: 'none',
        }}
      >
        <Link href="/messages" style={{ color: tokens.colors.text.primary, textDecoration: 'none' }}>
          <Box style={{ 
            padding: tokens.spacing[2], 
            borderRadius: tokens.radius.md,
            display: 'flex',
            alignItems: 'center'
          }}>
            ← 返回
          </Box>
        </Link>
        
        {otherUser && (
          <Link href={`/u/${otherUser.handle}`} style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Avatar
              userId={otherUser.id}
              name={otherUser.handle}
              avatarUrl={otherUser.avatar_url}
              size={40}
            />
            <Box>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                @{otherUser.handle}
              </Text>
              {otherUser.bio && (
                <Text size="xs" color="secondary" style={{ 
                  maxWidth: 300, 
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis', 
                  whiteSpace: 'nowrap' 
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
              margin: `${tokens.spacing[4]} 0`,
              position: 'relative'
            }}>
              <Text
                size="xs"
                color="tertiary"
                style={{
                  background: tokens.colors.bg.primary,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {formatDate(group.date)}
              </Text>
            </Box>
            
            {/* Messages */}
            {group.messages.map((msg) => {
              const isMine = msg.sender_id === userId
              return (
                <Box
                  key={msg.id}
                  style={{
                    display: 'flex',
                    justifyContent: isMine ? 'flex-end' : 'flex-start',
                    marginBottom: tokens.spacing[3],
                  }}
                >
                  <Box
                    style={{
                      maxWidth: '70%',
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderRadius: isMine 
                        ? `${tokens.radius.xl} ${tokens.radius.xl} ${tokens.radius.sm} ${tokens.radius.xl}`
                        : `${tokens.radius.xl} ${tokens.radius.xl} ${tokens.radius.xl} ${tokens.radius.sm}`,
                      background: isMine ? '#8b6fa8' : tokens.colors.bg.secondary,
                      color: isMine ? '#fff' : tokens.colors.text.primary,
                      border: isMine ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {msg.content}
                    </Text>
                    <Text 
                      size="xs" 
                      style={{ 
                        opacity: 0.7, 
                        marginTop: tokens.spacing[1],
                        textAlign: 'right'
                      }}
                    >
                      {formatTime(msg.created_at)}
                    </Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        
        {messages.length === 0 && (
          <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
            <Text size="sm" color="secondary">
              开始和 @{otherUser?.handle} 聊天吧
            </Text>
          </Box>
        )}
        
        <div ref={messagesEndRef} />
      </Box>

      {/* Input Area */}
      <Box
        bg="secondary"
        p={4}
        border="primary"
        style={{
          borderLeft: 'none',
          borderRight: 'none',
          borderBottom: 'none',
        }}
      >
        <Box style={{ 
          maxWidth: 800, 
          margin: '0 auto',
          display: 'flex',
          gap: tokens.spacing[3],
          alignItems: 'flex-end'
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
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              resize: 'none',
              minHeight: 44,
              maxHeight: 120,
            }}
          />
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!newMessage.trim() || sending}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.lg,
            }}
          >
            {sending ? '发送中...' : '发送'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

