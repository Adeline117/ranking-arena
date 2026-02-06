'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { getProfileUrl, getSafeProfileUrl } from '@/lib/utils/profile-navigation'
import {
  MessageErrorCode,
  getAuthSession,
  refreshAuthToken,
  resolveErrorCode,
  getErrorMessage,
} from '@/lib/auth'
import { useRealtime } from '@/lib/hooks/useRealtime'
import ChatSettingsDrawer from '@/app/components/features/ChatSettingsDrawer'
import ChatSearchOverlay from '@/app/components/features/ChatSearchOverlay'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type MessageStatus = 'sending' | 'sent' | 'failed'

type MediaAttachment = {
  url: string
  type: 'image' | 'video' | 'file'
  fileName?: string
  originalName?: string
  fileSize?: number
}

type Message = {
  id: string
  sender_id: string
  receiver_id: string
  content: string
  read: boolean
  created_at: string
  media_url?: string | null
  media_type?: 'image' | 'video' | 'file' | null
  media_name?: string | null
  _status?: MessageStatus
  _tempId?: string
  _errorCode?: MessageErrorCode
  _errorMessage?: string
  _attachment?: MediaAttachment
}

type OtherUser = {
  id: string
  handle: string | null
  avatar_url?: string | null
  bio?: string | null
}

// Helper to get media type label
function getMediaTypeLabel(type: 'image' | 'video' | 'file', t: (key: string) => string): string {
  switch (type) {
    case 'image': return t('image')
    case 'video': return t('video')
    case 'file': return t('file')
  }
}

// Helper to calculate message bubble border radius based on grouping
function getBubbleBorderRadius(isMine: boolean, isSameSenderAsPrev: boolean, isSameSenderAsNext: boolean): string {
  if (isMine) {
    if (isSameSenderAsPrev && isSameSenderAsNext) return '18px 6px 6px 18px'
    if (isSameSenderAsPrev) return '18px 6px 18px 18px'
    if (isSameSenderAsNext) return '18px 18px 6px 18px'
    return '18px'
  }
  if (isSameSenderAsPrev && isSameSenderAsNext) return '6px 18px 18px 6px'
  if (isSameSenderAsPrev) return '6px 18px 18px 18px'
  if (isSameSenderAsNext) return '18px 18px 18px 6px'
  return '18px'
}

// Helper to update message status in state
function updateMessageStatus(
  messages: Message[],
  identifier: string,
  isTemp: boolean,
  status: MessageStatus,
  errorCode?: MessageErrorCode,
  errorMessage?: string
): Message[] {
  return messages.map(m => {
    const match = isTemp ? m._tempId === identifier : m.id === identifier
    if (!match) return m
    return {
      ...m,
      _status: status,
      _errorCode: errorCode,
      _errorMessage: errorMessage,
    }
  })
}

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const [conversationId, setConversationId] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authChecked, setAuthChecked] = useState(false) // 追踪认证检查是否完成
  const [messages, setMessages] = useState<Message[]>([])
  const [otherUser, setOtherUser] = useState<OtherUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('connected')
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [remark, setRemark] = useState<string | null>(null)
  const [clearedBefore, setClearedBefore] = useState<string | null>(null)
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [pendingAttachment, setPendingAttachment] = useState<MediaAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<{ type: 'image' | 'video'; url: string } | null>(null)

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

  // 使用统一的 auth 工具检查认证状态，自动处理 token 刷新
  useEffect(() => {
    getAuthSession().then((auth) => {
      if (auth) {
        setUserId(auth.userId)
        setAccessToken(auth.accessToken)
        // 获取 email 用于 TopNav 显示
        supabase.auth.getSession().then(({ data }) => {
          setEmail(data.session?.user?.email ?? null)
        })
      } else {
        setUserId(null)
        setAccessToken(null)
      }
      setAuthChecked(true)

      if (auth?.userId && conversationId) {
        loadMessages(auth.userId, conversationId, auth.accessToken)
      }
    })

    // 监听 auth 状态变化（logout、token刷新等）
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) {
        setUserId(session.user.id)
        setEmail(session.user.email ?? null)
        setAccessToken(session.access_token)
      } else {
        setUserId(null)
        setEmail(null)
        setAccessToken(null)
      }
    })

    return () => {
      subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // Load conversation member settings (remark, muted, pinned, cleared_before)
  useEffect(() => {
    if (!conversationId || !accessToken) return
    fetch(`/api/chat/${conversationId}/settings`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.settings) {
          setRemark(data.settings.remark || null)
          setClearedBefore(data.settings.cleared_before || null)
        }
      })
      .catch(() => {})
  }, [conversationId, accessToken])

  // Navigate to a specific message (for search)
  const navigateToMessage = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId)
    const el = messageRefs.current[messageId]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      // Clear highlight after animation
      setTimeout(() => setHighlightedMessageId(null), 2000)
    }
  }, [])

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

      // 确保有有效 token
      let authToken = token
      if (!authToken) {
        const auth = await getAuthSession()
        if (!auth) {
          showToast(t('pleaseLogin'), 'error')
          router.push('/login')
          return
        }
        authToken = auth.accessToken
      }

      const res = await fetch(`/api/messages?conversationId=${convId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` },
      })

      // 如果 401，尝试刷新后重试
      if (res.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {

          const retryRes = await fetch(`/api/messages?conversationId=${convId}`, {
            headers: { 'Authorization': `Bearer ${refreshed.accessToken}` },
          })
          const retryData = await retryRes.json()
          if (retryRes.ok && retryData.messages) {
            setMessages(retryData.messages)
            if (retryData.otherUser) setOtherUser(retryData.otherUser)
            return
          }
        }
        showToast(t('loginExpiredPleaseRelogin'), 'error')
        router.push('/login')
        return
      }

      const data = await res.json()

      if (!res.ok) {
        showToast(data.error || t('loadMessagesFailed'), 'error')
        router.push('/messages')
        return
      }

      if (data.messages) {
        setMessages(data.messages)
        if (data.otherUser) {
          setOtherUser(data.otherUser)
        }
      }
    } catch {
      showToast(t('networkErrorLoadMessages'), 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast, router, t])

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
      showToast(t('loadOlderMessagesFailed'), 'error')
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

  /**
   * 发送消息的核心函数
   * 处理 auth token 获取、发送、401 自动刷新重试
   */
  const sendMessageRequest = async (
    receiverId: string,
    content: string,
    token: string,
    attachment?: MediaAttachment | null
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> => {
    const body: Record<string, unknown> = { receiverId, content }
    if (attachment) {
      body.media_url = attachment.url
      body.media_type = attachment.type
      body.media_name = attachment.originalName
    }
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...getCsrfHeaders()
      },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    return { ok: res.ok, status: res.status, data }
  }

  const handleSend = async () => {
    const hasContent = newMessage.trim() || pendingAttachment
    if (!hasContent || !userId || !otherUser || sending) return

    const content = newMessage.trim()
    if (content.length > 2000) {
      showToast(t('messageTooLong'), 'warning')
      return
    }

    // 先确保有有效的 auth token
    const auth = await getAuthSession()
    if (!auth) {
      showToast(t('pleaseLogin'), 'error')
      router.push('/login')
      return
    }

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticMessage: Message = {
      id: tempId,
      sender_id: userId,
      receiver_id: otherUser.id,
      content: content || (pendingAttachment ? `[${getMediaTypeLabel(pendingAttachment.type, t)}]` : ''),
      read: false,
      created_at: new Date().toISOString(),
      _status: 'sending',
      _tempId: tempId,
      _attachment: pendingAttachment || undefined,
      media_url: pendingAttachment?.url,
      media_type: pendingAttachment?.type,
      media_name: pendingAttachment?.originalName,
    }

    // Optimistic: show message immediately
    setMessages(prev => [...prev, optimisticMessage])
    setNewMessage('')
    setPendingAttachment(null)
    inputRef.current?.focus()

    setSending(true)
    try {
      let result = await sendMessageRequest(
        otherUser.id,
        content || (pendingAttachment ? `[${getMediaTypeLabel(pendingAttachment.type, t)}]` : ''),
        auth.accessToken,
        pendingAttachment
      )

      // 如果 401，尝试刷新 token 后重试一次
      if (result.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          result = await sendMessageRequest(
            otherUser.id,
            content || (optimisticMessage._attachment ? `[${getMediaTypeLabel(optimisticMessage._attachment.type, t)}]` : ''),
            refreshed.accessToken,
            optimisticMessage._attachment
          )
        } else {
          const errorCode = MessageErrorCode.NOT_AUTHENTICATED
          setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', errorCode, getErrorMessage(errorCode)))
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          return
        }
      }

      if (!result.ok) {
        const errorCode = resolveErrorCode(result.status, result.data as { error_code?: string; error?: string })
        const errorMsg = getErrorMessage(errorCode, result.data.error as string)
        setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', errorCode, errorMsg))
        showToast(errorMsg, 'error')
        return
      }

      if (result.data.message) {
        setMessages(prev => prev.map(m =>
          m._tempId === tempId
            ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus }
            : m
        ))
      }
    } catch {
      const errorCode = MessageErrorCode.NETWORK_ERROR
      const errorMsg = getErrorMessage(errorCode)
      setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', errorCode, errorMsg))
      showToast(errorMsg, 'error')
    } finally {
      setSending(false)
    }
  }

  const handleRetry = async (failedMsg: Message) => {
    if (!otherUser) return

    // 重试前先验证登录态
    const auth = await getAuthSession()
    if (!auth) {
      // 尝试刷新 token
      const refreshed = await refreshAuthToken()
      if (!refreshed) {
        showToast(t('loginExpiredPleaseRelogin'), 'error')
        router.push('/login')
        return
      }
      setUserId(refreshed.userId)
    }

    const currentAuth = auth || (await getAuthSession())
    if (!currentAuth) {
      showToast(t('pleaseLogin'), 'error')
      router.push('/login')
      return
    }

    setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'sending'))

    try {
      let result = await sendMessageRequest(otherUser.id, failedMsg.content, currentAuth.accessToken, failedMsg._attachment)

      if (result.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          result = await sendMessageRequest(otherUser.id, failedMsg.content, refreshed.accessToken, failedMsg._attachment)
        } else {
          const errorCode = MessageErrorCode.NOT_AUTHENTICATED
          setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', errorCode, getErrorMessage(errorCode)))
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          return
        }
      }

      if (!result.ok) {
        const errorCode = resolveErrorCode(result.status, result.data as { error_code?: string; error?: string })
        const errorMsg = getErrorMessage(errorCode, result.data.error as string)
        setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', errorCode, errorMsg))
        showToast(errorMsg, 'error')
        return
      }

      if (result.data.message) {
        setMessages(prev => prev.map(m =>
          m.id === failedMsg.id
            ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus }
            : m
        ))
      }
    } catch {
      const errorCode = MessageErrorCode.NETWORK_ERROR
      const errorMsg = getErrorMessage(errorCode)
      setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', errorCode, errorMsg))
      showToast(errorMsg, 'error')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // File upload handler
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId || !conversationId) return

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)
      formData.append('conversationId', conversationId)

      const res = await fetch('/api/chat/upload', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        showToast(data.error || t('uploadFailed'), 'error')
        return
      }

      setPendingAttachment({
        url: data.url,
        type: data.category,
        fileName: data.fileName,
        originalName: data.originalName,
        fileSize: data.fileSize,
      })
    } catch {
      showToast(t('uploadFailedRetry'), 'error')
    } finally {
      setUploading(false)
    }
  }

  const clearAttachment = () => {
    setPendingAttachment(null)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const formatTime = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
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
      return t('today')
    } else if (date.toDateString() === yesterday.toDateString()) {
      return t('yesterday')
    } else {
      return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
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
          <Text size="lg">{t('loading')}</Text>
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
              {t('pleaseLogin')}
            </Text>
            <Text size="sm" color="tertiary" style={{ maxWidth: 280, margin: '0 auto', lineHeight: 1.6, marginBottom: tokens.spacing[4] }}>
              {t('loginToViewMessages')}
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
              {t('goToLogin')}
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
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  // Filter messages based on cleared_before
  const visibleMessages = clearedBefore
    ? messages.filter(msg => new Date(msg.created_at) > new Date(clearedBefore))
    : messages

  const messageGroups = groupMessagesByDate(visibleMessages)

  return (
    <Box style={{
      minHeight: '100vh',
      background: tokens.colors.bg.primary,
      color: tokens.colors.text.primary,
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
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
        
        {otherUser && (() => {
          const profileUrl = getSafeProfileUrl(otherUser, userId)
          const displayName = otherUser.handle || `User ${otherUser.id.slice(0, 8)}`

          if (!profileUrl) {
            // No valid profile URL - show info without link
            return (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                  flex: 1,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                }}
              >
                <Avatar
                  userId={otherUser.id}
                  name={displayName}
                  avatarUrl={otherUser.avatar_url}
                  size={44}
                />
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>
                    {remark || displayName}
                  </Text>
                  {remark && (
                    <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                      @{displayName}
                    </Text>
                  )}
                </Box>
              </Box>
            )
          }

          return (
            <Link
              href={profileUrl}
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
                  name={displayName}
                  avatarUrl={otherUser.avatar_url}
                  size={44}
                />
              </Box>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary }}>
                  {remark || displayName}
                </Text>
                {remark && (
                  <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                    @{displayName}
                  </Text>
                )}
                {!remark && otherUser.bio && (
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
          )
        })()}

        {/* Search button */}
        {otherUser && (
          <button
            onClick={() => setSearchOpen(true)}
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = tokens.colors.text.secondary
            }}
            title={t('searchChatHistory')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        )}

        {/* Settings button */}
        {otherUser && (
          <button
            onClick={() => setSettingsOpen(true)}
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)'
              e.currentTarget.style.color = tokens.colors.text.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = tokens.colors.text.secondary
            }}
            title={t('chatSettings')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
              <circle cx="5" cy="12" r="1" />
            </svg>
          </button>
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
          {connectionStatus === 'reconnecting' ? t('reconnectingMessage') : t('connectionLostMessage')}
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
              {loadingMore ? t('loading') : t('loadOlderMessages')}
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
              
              // Show avatar for first message in a group from the other user
              const showOtherAvatar = !isMine && !isSameSenderAsPrev
              const otherProfileUrl = !isMine ? getSafeProfileUrl(otherUser, userId) : null

              return (
                <div
                  key={msg.id}
                  ref={(el: HTMLDivElement | null) => { messageRefs.current[msg.id] = el }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isMine ? 'flex-end' : 'flex-start',
                    marginBottom: isSameSenderAsNext ? '2px' : tokens.spacing[3],
                    transition: 'background 0.3s',
                    borderRadius: 12,
                    background: highlightedMessageId === msg.id ? 'rgba(149, 117, 205, 0.15)' : 'transparent',
                    padding: highlightedMessageId === msg.id ? '4px' : '0px',
                  }}
                >
                  {/* Message row with avatar */}
                  <Box style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 8,
                    maxWidth: '80%',
                    flexDirection: isMine ? 'row-reverse' : 'row',
                  }}>
                    {/* Other user's avatar */}
                    {!isMine && (
                      <Box style={{ width: 28, flexShrink: 0 }}>
                        {showOtherAvatar && otherUser && (
                          otherProfileUrl ? (
                            <Link
                              href={otherProfileUrl}
                              style={{ textDecoration: 'none', display: 'block' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Avatar
                                userId={otherUser.id}
                                name={otherUser.handle || `User ${otherUser.id.slice(0, 8)}`}
                                avatarUrl={otherUser.avatar_url}
                                size={28}
                              />
                            </Link>
                          ) : (
                            <Avatar
                              userId={otherUser.id}
                              name={otherUser.handle || `User ${otherUser.id.slice(0, 8)}`}
                              avatarUrl={otherUser.avatar_url}
                              size={28}
                            />
                          )
                        )}
                      </Box>
                    )}

                  {/* Message bubble */}
                  <Box
                    style={{
                      maxWidth: '75%',
                      minWidth: 48,
                      padding: (msg.media_url && msg.media_type !== 'file') ? '4px' : '10px 14px',
                      borderRadius: getBubbleBorderRadius(isMine, isSameSenderAsPrev, isSameSenderAsNext),
                      background: isMine
                        ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)'
                        : tokens.colors.bg.secondary,
                      color: isMine ? '#fff' : tokens.colors.text.primary,
                      border: isMine
                        ? msg._status === 'failed' ? '1px solid rgba(244, 67, 54, 0.6)' : 'none'
                        : `1px solid ${tokens.colors.border.primary}`,
                      boxShadow: isMine
                        ? '0 1px 2px rgba(126, 87, 194, 0.2)'
                        : '0 1px 2px rgba(0,0,0,0.05)',
                      opacity: msg._status === 'sending' ? 0.7 : 1,
                      transition: 'opacity 0.2s',
                      overflow: 'hidden',
                    }}
                  >
                    {/* Media content */}
                    {msg.media_url && msg.media_type === 'image' && (
                      <Image
                        src={msg.media_url}
                        alt=""
                        width={400}
                        height={300}
                        onClick={() => setPreviewOpen({ type: 'image', url: msg.media_url! })}
                        style={{
                          maxWidth: '100%',
                          maxHeight: 300,
                          borderRadius: 14,
                          cursor: 'pointer',
                          display: 'block',
                          objectFit: 'contain',
                        }}
                        unoptimized
                      />
                    )}
                    {msg.media_url && msg.media_type === 'video' && (
                      <Box
                        onClick={() => setPreviewOpen({ type: 'video', url: msg.media_url! })}
                        style={{
                          position: 'relative',
                          cursor: 'pointer',
                          borderRadius: 14,
                          overflow: 'hidden',
                        }}
                      >
                        <video
                          src={msg.media_url}
                          style={{
                            maxWidth: '100%',
                            maxHeight: 300,
                            display: 'block',
                          }}
                        />
                        <Box style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'rgba(0,0,0,0.3)',
                        }}>
                          <Box style={{
                            width: 48,
                            height: 48,
                            borderRadius: '50%',
                            background: 'rgba(255,255,255,0.9)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="#333">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                          </Box>
                        </Box>
                      </Box>
                    )}
                    {msg.media_url && msg.media_type === 'file' && (
                      <a
                        href={msg.media_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          textDecoration: 'none',
                          color: 'inherit',
                        }}
                      >
                        <Box style={{
                          width: 40,
                          height: 40,
                          borderRadius: 8,
                          background: isMine ? 'rgba(255,255,255,0.2)' : tokens.colors.bg.tertiary,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        </Box>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm" style={{
                            fontWeight: 600,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {msg.media_name || t('file')}
                          </Text>
                          <Text size="xs" style={{ opacity: 0.7 }}>
                            {t('clickToDownload')}
                          </Text>
                        </Box>
                      </a>
                    )}
                    {/* Text content */}
                    {msg.content && !msg.content.startsWith('[') && (
                      <Text
                        size="sm"
                        style={{
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          lineHeight: 1.5,
                          marginTop: msg.media_url ? 8 : 0,
                          padding: msg.media_url && msg.media_type !== 'file' ? '0 10px 6px' : 0,
                        }}
                      >
                        {msg.content}
                      </Text>
                    )}
                    {/* Show text for messages without media */}
                    {!msg.media_url && (
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
                    )}
                  </Box>
                  </Box>{/* close message row with avatar */}

                  {/* Failed state: error reason + retry button */}
                  {isMine && msg._status === 'failed' && (
                    <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, marginTop: 4 }}>
                      {/* 显示具体错误原因 */}
                      <Text size="xs" style={{ color: '#f44336', fontSize: 11, fontWeight: 500 }}>
                        {msg._errorMessage || t('sendFailed')}
                      </Text>
                      {/* 重试按钮 - 对于权限错误不显示重试 */}
                      {msg._errorCode !== MessageErrorCode.PERMISSION_DENIED && (
                        <button
                          onClick={() => handleRetry(msg)}
                          style={{
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
                          {msg._errorCode === MessageErrorCode.NOT_AUTHENTICATED ? t('relogin') : t('clickToRetry')}
                        </button>
                      )}
                    </Box>
                  )}

                  {/* 时间戳 + 状态指示器 */}
                  {showTime && msg._status !== 'failed' && (
                    <Text
                      size="xs"
                      color="tertiary"
                      style={{
                        marginTop: 4,
                        paddingLeft: isMine ? 0 : 36,
                        paddingRight: isMine ? 4 : 0,
                        fontSize: 11,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                      }}
                    >
                      {msg._status === 'sending' ? (
                        <span style={{ opacity: 0.6 }}>{t('sending')}</span>
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
                </div>
              )
            })}
          </Box>
        ))}
        
        {visibleMessages.length === 0 && (
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
                {t('startConversation')}
              </Text>
              <Text size="sm" color="tertiary">
                {t('sendFirstMessage').replace('{handle}', otherUser?.handle || `User ${otherUser?.id.slice(0, 8)}`)}
              </Text>
            </Box>
          </Box>
        )}
        
        <div ref={messagesEndRef} />
      </Box>

      {/* Search Overlay */}
      {conversationId && accessToken && (
        <ChatSearchOverlay
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          conversationId={conversationId}
          accessToken={accessToken}
          onNavigateToMessage={(messageId) => {
            setSearchOpen(false)
            // Small delay to allow overlay to close
            setTimeout(() => navigateToMessage(messageId), 100)
          }}
        />
      )}

      {/* Settings Drawer */}
      {otherUser && conversationId && accessToken && (
        <ChatSettingsDrawer
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          conversationId={conversationId}
          otherUser={{ id: otherUser.id, handle: otherUser.handle || null, avatar_url: otherUser.avatar_url ?? undefined, bio: otherUser.bio ?? undefined }}
          accessToken={accessToken}
          onSettingsChange={(newSettings) => {
            setRemark(newSettings.remark)
            if (newSettings.cleared_before) {
              setClearedBefore(newSettings.cleared_before)
            }
          }}
          onSearchOpen={() => setSearchOpen(true)}
          onClearHistory={() => {
            setClearedBefore(new Date().toISOString())
          }}
        />
      )}

      {/* Media Preview Overlay */}
      {previewOpen && (
        <Box
          onClick={() => setPreviewOpen(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.9)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <button
            onClick={() => setPreviewOpen(null)}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(255,255,255,0.1)',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          {previewOpen.type === 'image' ? (
            <Image
              src={previewOpen.url}
              alt=""
              width={1200}
              height={900}
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                objectFit: 'contain',
                borderRadius: 8,
              }}
              unoptimized
            />
          ) : (
            <video
              src={previewOpen.url}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '90vw',
                maxHeight: '90vh',
                borderRadius: 8,
              }}
            />
          )}
        </Box>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip,.rar"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      {/* Input Area */}
      <Box
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        {/* Attachment preview */}
        {pendingAttachment && (
          <Box style={{
            maxWidth: 800,
            margin: '0 auto',
            marginBottom: 8,
            padding: 8,
            background: tokens.colors.bg.tertiary,
            borderRadius: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            {pendingAttachment.type === 'image' ? (
              <Image
                src={pendingAttachment.url}
                alt=""
                width={60}
                height={60}
                style={{
                  width: 60,
                  height: 60,
                  objectFit: 'cover',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
                onClick={() => setPreviewOpen({ type: 'image', url: pendingAttachment.url })}
                unoptimized
              />
            ) : pendingAttachment.type === 'video' ? (
              <Box
                onClick={() => setPreviewOpen({ type: 'video', url: pendingAttachment.url })}
                style={{
                  width: 60,
                  height: 60,
                  borderRadius: 8,
                  background: tokens.colors.bg.primary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </Box>
            ) : (
              <Box style={{
                width: 60,
                height: 60,
                borderRadius: 8,
                background: tokens.colors.bg.primary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.secondary} strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </Box>
            )}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" style={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {pendingAttachment.originalName}
              </Text>
              <Text size="xs" color="tertiary">
                {pendingAttachment.fileSize ? formatFileSize(pendingAttachment.fileSize) : ''} • {getMediaTypeLabel(pendingAttachment.type, t)}
              </Text>
            </Box>
            <button
              onClick={clearAttachment}
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'rgba(244, 67, 54, 0.15)',
                color: '#f44336',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </Box>
        )}

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
          padding: '6px 6px 6px 12px',
          border: `1px solid ${tokens.colors.border.primary}`,
          transition: 'border-color 0.2s, box-shadow 0.2s',
        }}>
          {/* File upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.tertiary,
              cursor: uploading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              opacity: uploading ? 0.5 : 1,
              transition: 'all 0.2s',
            }}
            title={t('sendMediaFile')}
          >
            {uploading ? (
              <Box style={{
                width: 18,
                height: 18,
                border: '2px solid currentColor',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            )}
          </button>
          <textarea
            ref={inputRef}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('enterMessage')}
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
            disabled={(!newMessage.trim() && !pendingAttachment) || sending || newMessage.length > 2000}
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              border: 'none',
              background: (newMessage.trim() || pendingAttachment) && newMessage.length <= 2000
                ? 'linear-gradient(135deg, #9575cd 0%, #7e57c2 100%)'
                : tokens.colors.bg.tertiary || 'rgba(255,255,255,0.1)',
              color: (newMessage.trim() || pendingAttachment) && newMessage.length <= 2000 ? '#fff' : tokens.colors.text.tertiary,
              cursor: (newMessage.trim() || pendingAttachment) && !sending && newMessage.length <= 2000 ? 'pointer' : 'default',
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

