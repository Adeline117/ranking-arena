'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  MessageErrorCode,
  getAuthSession,
  refreshAuthToken,
  resolveErrorCode,
  getErrorMessage,
} from '@/lib/auth'
import { useRealtime } from '@/lib/hooks/useRealtime'
import { usePresence } from '@/lib/hooks/usePresence'
import ChatSettingsDrawer from '@/app/components/features/ChatSettingsDrawer'
import ChatSearchOverlay from '@/app/components/features/ChatSearchOverlay'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

import { getMediaTypeLabel, updateMessageStatus, groupMessagesByDate } from './components/types'
import type { Message, MediaAttachment, OtherUser, MessageStatus } from './components/types'
import ConversationHeader from './components/ConversationHeader'
import MessageBubble from './components/MessageBubble'
import MessageInput from './components/MessageInput'
import MediaPreview from './components/MediaPreview'

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const [conversationId, setConversationId] = useState<string>('')
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
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
  const _channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [pendingAttachment, setPendingAttachment] = useState<MediaAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<{ type: 'image' | 'video' | 'file'; url: string; fileName?: string } | null>(null)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [isDragging, setIsDragging] = useState(false)

  // Online presence
  const watchIds = otherUser ? [otherUser.id] : []
  const { getUserPresence } = usePresence(userId, watchIds)
  const otherPresence = otherUser ? getUserPresence(otherUser.id) : null

  // Mark messages as read when conversation opens
  useEffect(() => {
    if (!conversationId || !accessToken) return
    fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
      body: JSON.stringify({ conversationId }),
    }).catch(() => {})
  }, [conversationId, accessToken])

  // Inject spin animation
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
      (params as Promise<{ conversationId: string }>).then(resolved => { setConversationId(resolved.conversationId) })
    } else {
      setConversationId(String((params as { conversationId: string })?.conversationId ?? ''))
    }
  }, [params])

  // Auth check
  useEffect(() => {
    getAuthSession().then((auth) => {
      if (auth) {
        setUserId(auth.userId)
        setAccessToken(auth.accessToken)
        supabase.auth.getSession().then(({ data }) => { setEmail(data.session?.user?.email ?? null) })
      } else { setUserId(null); setAccessToken(null) }
      setAuthChecked(true)
      if (auth?.userId && conversationId) { loadMessages(auth.userId, conversationId, auth.accessToken) }
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) { setUserId(session.user.id); setEmail(session.user.email ?? null); setAccessToken(session.access_token) }
      else { setUserId(null); setEmail(null); setAccessToken(null) }
    })
    return () => { subscription.unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // Load settings
  useEffect(() => {
    if (!conversationId || !accessToken) return
    fetch(`/api/chat/${conversationId}/settings`, { headers: { 'Authorization': `Bearer ${accessToken}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.settings) { setRemark(data.settings.remark || null); setClearedBefore(data.settings.cleared_before || null) } })
      .catch(() => {})
  }, [conversationId, accessToken])

  const navigateToMessage = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId)
    const el = messageRefs.current[messageId]
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => setHighlightedMessageId(null), 2000) }
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  const isLoadingOlderRef = useRef(false)
  const prevMessageCountRef = useRef(0)

  useEffect(() => {
    if (isLoadingOlderRef.current) { isLoadingOlderRef.current = false; prevMessageCountRef.current = messages.length; return }
    if (messages.length > 0) { scrollToBottom(prevMessageCountRef.current === 0 ? 'instant' : 'smooth') }
    prevMessageCountRef.current = messages.length
  }, [messages, scrollToBottom])

  const loadMessages = useCallback(async (uid: string, convId: string, token?: string) => {
    try {
      setLoading(true)
      let authToken = token
      if (!authToken) { const auth = await getAuthSession(); if (!auth) { showToast(t('pleaseLogin'), 'error'); router.push('/login?redirect=/inbox'); return }; authToken = auth.accessToken }
      const res = await fetch(`/api/messages?conversationId=${convId}`, { headers: { 'Authorization': `Bearer ${authToken}` } })
      if (res.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) {
          const retryRes = await fetch(`/api/messages?conversationId=${convId}`, { headers: { 'Authorization': `Bearer ${refreshed.accessToken}` } })
          const retryData = await retryRes.json()
          if (retryRes.ok && retryData.messages) { setMessages(retryData.messages); if (retryData.otherUser) setOtherUser(retryData.otherUser); return }
        }
        showToast(t('loginExpiredPleaseRelogin'), 'error'); router.push('/login?redirect=/inbox'); return
      }
      const data = await res.json()
      if (!res.ok) { showToast(data.error || t('loadMessagesFailed'), 'error'); router.push('/messages'); return }
      if (data.messages) { setMessages(data.messages); if (data.otherUser) setOtherUser(data.otherUser) }
    } catch { showToast(t('networkErrorLoadMessages'), 'error') }
    finally { setLoading(false) }
  }, [showToast, router, t])

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || !accessToken || loadingMore || !hasMore) return
    const oldest = messages.find(m => !m._tempId)
    if (!oldest) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/messages?conversationId=${conversationId}&before=${oldest.created_at}`, { headers: { 'Authorization': `Bearer ${accessToken}` } })
      const data = await res.json()
      if (data.messages?.length) { isLoadingOlderRef.current = true; setMessages(prev => [...data.messages, ...prev]); setHasMore(!!data.has_more) }
      else { setHasMore(false) }
    } catch { showToast(t('loadOlderMessagesFailed'), 'error') }
    finally { setLoadingMore(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, accessToken, loadingMore, hasMore, messages, showToast])

  // Realtime subscriptions
  useRealtime<Message>({
    table: 'direct_messages', event: 'INSERT',
    filter: otherUser ? `sender_id=eq.${otherUser.id}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true, maxRetries: 10,
    onInsert: (newMsg) => {
      if (newMsg.receiver_id === userId) {
        setMessages(prev => { if (prev.some(m => m.id === newMsg.id)) return prev; return [...prev, newMsg] })
        if (accessToken && conversationId) {
          fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }, body: JSON.stringify({ conversationId }) }).catch(() => {})
        }
      }
    },
    onStatusChange: (status) => {
      if (status === 'connected') setConnectionStatus('connected')
      else if (status === 'disconnected' || status === 'error') setConnectionStatus('disconnected')
      else if (status === 'reconnecting') setConnectionStatus('reconnecting')
    },
  })

  useRealtime<Message>({
    table: 'direct_messages', event: 'UPDATE',
    filter: userId ? `sender_id=eq.${userId}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true, maxRetries: 5,
    onUpdate: ({ new: updatedMsg }) => {
      if (updatedMsg.read) { setMessages(prev => prev.map(m => m.id === updatedMsg.id ? { ...m, read: true, read_at: updatedMsg.read_at } : m)) }
    },
  })

  // Send message
  const sendMessageRequest = async (receiverId: string, content: string, token: string, attachment?: MediaAttachment | null) => {
    const body: Record<string, unknown> = { receiverId, content }
    if (attachment) { body.media_url = attachment.url; body.media_type = attachment.type; body.media_name = attachment.originalName }
    const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...getCsrfHeaders() }, body: JSON.stringify(body) })
    const data = await res.json()
    return { ok: res.ok, status: res.status, data }
  }

  const handleSend = async () => {
    const hasContent = newMessage.trim() || pendingAttachment
    if (!hasContent || !userId || !otherUser || sending) return
    const content = newMessage.trim()
    if (content.length > 2000) { showToast(t('messageTooLong'), 'warning'); return }
    const auth = await getAuthSession()
    if (!auth) { showToast(t('pleaseLogin'), 'error'); router.push('/login?redirect=/inbox'); return }

    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticMessage: Message = {
      id: tempId, sender_id: userId, receiver_id: otherUser.id,
      content: content || (pendingAttachment ? `[${getMediaTypeLabel(pendingAttachment.type, t)}]` : ''),
      read: false, created_at: new Date().toISOString(), _status: 'sending', _tempId: tempId,
      _attachment: pendingAttachment || undefined, media_url: pendingAttachment?.url, media_type: pendingAttachment?.type, media_name: pendingAttachment?.originalName,
    }
    setMessages(prev => [...prev, optimisticMessage]); setNewMessage(''); setPendingAttachment(null); inputRef.current?.focus()

    setSending(true)
    try {
      let result = await sendMessageRequest(otherUser.id, optimisticMessage.content, auth.accessToken, pendingAttachment)
      if (result.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) { result = await sendMessageRequest(otherUser.id, optimisticMessage.content, refreshed.accessToken, optimisticMessage._attachment) }
        else { const ec = MessageErrorCode.NOT_AUTHENTICATED; setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, getErrorMessage(ec))); showToast(t('loginExpiredPleaseRelogin'), 'error'); return }
      }
      if (!result.ok) {
        const ec = resolveErrorCode(result.status, result.data as { error_code?: string; error?: string }); const em = getErrorMessage(ec, result.data.error as string)
        setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, em)); showToast(em, 'error'); return
      }
      if (result.data.message) { setMessages(prev => prev.map(m => m._tempId === tempId ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus } : m)) }
    } catch { const ec = MessageErrorCode.NETWORK_ERROR; const em = getErrorMessage(ec); setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, em)); showToast(em, 'error') }
    finally { setSending(false) }
  }

  const handleRetry = async (failedMsg: Message) => {
    if (!otherUser) return
    const auth = await getAuthSession()
    if (!auth) { const refreshed = await refreshAuthToken(); if (!refreshed) { showToast(t('loginExpiredPleaseRelogin'), 'error'); router.push('/login?redirect=/inbox'); return }; setUserId(refreshed.userId) }
    const currentAuth = auth || (await getAuthSession())
    if (!currentAuth) { showToast(t('pleaseLogin'), 'error'); router.push('/login?redirect=/inbox'); return }
    setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'sending'))
    try {
      let result = await sendMessageRequest(otherUser.id, failedMsg.content, currentAuth.accessToken, failedMsg._attachment)
      if (result.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) { result = await sendMessageRequest(otherUser.id, failedMsg.content, refreshed.accessToken, failedMsg._attachment) }
        else { const ec = MessageErrorCode.NOT_AUTHENTICATED; setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, getErrorMessage(ec))); showToast(t('loginExpiredPleaseRelogin'), 'error'); return }
      }
      if (!result.ok) { const ec = resolveErrorCode(result.status, result.data as { error_code?: string; error?: string }); const em = getErrorMessage(ec, result.data.error as string); setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em)); showToast(em, 'error'); return }
      if (result.data.message) { setMessages(prev => prev.map(m => m.id === failedMsg.id ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus } : m)) }
    } catch { const ec = MessageErrorCode.NETWORK_ERROR; const em = getErrorMessage(ec); setMessages(prev => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em)); showToast(em, 'error') }
  }

  const handleVoiceSent = useCallback(async (voiceUrl: string, duration: number) => {
    if (!userId || !otherUser) return
    const content = `[Voice] ${t('voiceMessage')} (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`
    const auth = await getAuthSession()
    if (!auth) return
    const tempId = `voice-${Date.now()}`
    const tempMsg: Message = {
      id: tempId, sender_id: userId, receiver_id: otherUser.id, content, read: false, created_at: new Date().toISOString(),
      media_url: voiceUrl, media_type: 'file', media_name: 'voice-message.webm', _status: 'sending', _tempId: tempId,
    }
    setMessages(prev => [...prev, tempMsg])
    try { await sendMessageRequest(otherUser.id, content, auth.accessToken, { url: voiceUrl, type: 'file', fileName: 'voice-message.webm', originalName: 'voice-message.webm' }) }
    catch { setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m)) }
  }, [userId, otherUser, t])

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString); const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === today.toDateString()) return t('today')
    if (date.toDateString() === yesterday.toDateString()) return t('yesterday')
    return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric' })
  }

  // Auth / loading states
  if (!authChecked || (authChecked && !userId && loading)) {
    return (<Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}><TopNav email={email} /><Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}><Text size="lg">{t('loading')}</Text></Box></Box>)
  }
  if (authChecked && !userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 600, margin: '0 auto', padding: `${tokens.spacing[5]} ${tokens.spacing[4]}` }}>
          <Box style={{ textAlign: 'center', padding: `${tokens.spacing[10]} ${tokens.spacing[6]}`, background: tokens.colors.bg.secondary, borderRadius: tokens.radius['2xl'], border: `1px solid ${tokens.colors.border.primary}` }}>
            <Box style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-primary-15) 0%, var(--color-accent-primary-08) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', marginBottom: tokens.spacing[4] }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </Box>
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: tokens.colors.text.primary }}>{t('pleaseLogin')}</Text>
            <Text size="sm" color="tertiary" style={{ maxWidth: 280, margin: '0 auto', lineHeight: 1.6, marginBottom: tokens.spacing[4] }}>{t('loginToViewMessages')}</Text>
            <a href="/login" style={{ display: 'inline-block', padding: '12px 24px', background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, var(--color-brand-hover) 100%)`, color: tokens.colors.white, borderRadius: tokens.radius.lg, textDecoration: 'none', fontWeight: 700, fontSize: '14px' }}>{t('goToLogin')}</a>
          </Box>
        </Box>
      </Box>
    )
  }
  if (loading) {
    return (<Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}><TopNav email={email} /><Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}><Text size="lg">{t('loading')}</Text></Box></Box>)
  }

  const visibleMessages = clearedBefore ? messages.filter(msg => new Date(msg.created_at) > new Date(clearedBefore)) : messages
  const messageGroups = groupMessagesByDate(visibleMessages)

  return (
    <Box
      onDragOver={(e: React.DragEvent) => { e.preventDefault(); setIsDragging(true) }}
      onDragLeave={(e: React.DragEvent) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false) }}
      onDrop={async (e: React.DragEvent) => {
        e.preventDefault(); setIsDragging(false)
        const file = e.dataTransfer.files?.[0]
        if (file && userId && conversationId) {
          setUploading(true)
          try {
            const formData = new FormData(); formData.append('file', file); formData.append('userId', userId); formData.append('conversationId', conversationId)
            const res = await globalThis.fetch('/api/chat/upload', { method: 'POST', headers: getCsrfHeaders(), body: formData }); const data = await res.json()
            if (res.ok) { setPendingAttachment({ url: data.url, type: data.category, fileName: data.fileName, originalName: data.originalName, fileSize: data.fileSize }) }
            else { showToast(data.error || t('uploadFailed'), 'error') }
          } catch { showToast(t('uploadFailedRetry'), 'error') }
          finally { setUploading(false) }
        }
      }}
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary} 50%, ${tokens.colors.bg.primary} 100%)`,
        color: tokens.colors.text.primary, display: 'flex', flexDirection: 'column', position: 'relative',
      }}
    >
      {isDragging && (
        <Box style={{ position: 'absolute', inset: 0, zIndex: 999, background: 'var(--color-accent-primary-15)', border: `3px dashed ${tokens.colors.accent.brand}`, borderRadius: tokens.radius.lg, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.brand }}>{t('dragDropHint')}</Text>
        </Box>
      )}
      <TopNav email={email} />
      
      <ConversationHeader
        otherUser={otherUser}
        userId={userId}
        remark={remark}
        otherPresence={otherPresence}
        connectionStatus={connectionStatus}
        email={email}
        onSettingsOpen={() => setSettingsOpen(true)}
        onSearchOpen={() => setSearchOpen(true)}
        t={t}
      />

      {/* Messages Area */}
      <Box style={{ flex: 1, overflow: 'auto', padding: `${tokens.spacing[4]} ${tokens.spacing[4]} ${tokens.spacing[6]}`, maxWidth: 800, margin: '0 auto', width: '100%' }}>
        {hasMore && (
          <Box style={{ textAlign: 'center', marginBottom: 12 }}>
            <button onClick={loadOlderMessages} disabled={loadingMore} style={{ padding: '6px 16px', background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.xl, color: tokens.colors.text.secondary, fontSize: 13, cursor: loadingMore ? 'not-allowed' : 'pointer', opacity: loadingMore ? 0.6 : 1, transition: 'opacity 0.2s' }}>
              {loadingMore ? t('loading') : t('loadOlderMessages')}
            </button>
          </Box>
        )}

        {messageGroups.map((group, groupIndex) => (
          <Box key={groupIndex}>
            <Box style={{ textAlign: 'center', margin: `${tokens.spacing[5]} 0`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[3] }}>
              <Box style={{ flex: 1, height: 1, background: `linear-gradient(to right, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
              <Text size="xs" color="tertiary" style={{ fontSize: 11, letterSpacing: '0.5px', fontWeight: 600 }}>{formatDate(group.date)}</Text>
              <Box style={{ flex: 1, height: 1, background: `linear-gradient(to left, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
            </Box>
            
            {group.messages.map((msg, msgIndex) => {
              const isMine = msg.sender_id === userId
              const prevMsg = msgIndex > 0 ? group.messages[msgIndex - 1] : null
              const nextMsg = msgIndex < group.messages.length - 1 ? group.messages[msgIndex + 1] : null
              const isSameSenderAsPrev = prevMsg?.sender_id === msg.sender_id
              const isSameSenderAsNext = nextMsg?.sender_id === msg.sender_id

              return (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  isMine={isMine}
                  isSameSenderAsPrev={isSameSenderAsPrev}
                  isSameSenderAsNext={isSameSenderAsNext}
                  showTime={!isSameSenderAsNext}
                  showOtherAvatar={!isMine && !isSameSenderAsPrev}
                  otherUser={otherUser}
                  userId={userId}
                  highlightedMessageId={highlightedMessageId}
                  onRetry={handleRetry}
                  onPreviewOpen={setPreviewOpen}
                  formatTime={formatTime}
                  t={t}
                  messageRef={(el) => { messageRefs.current[msg.id] = el }}
                />
              )
            })}
          </Box>
        ))}
        
        {visibleMessages.length === 0 && (
          <Box style={{ textAlign: 'center', padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Box style={{ width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg, var(--color-accent-primary-20) 0%, var(--color-accent-primary-10) 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.brand} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </Box>
            <Box>
              <Text size="base" weight="bold" style={{ marginBottom: 4, color: tokens.colors.text.primary }}>{t('startConversation')}</Text>
              <Text size="sm" color="tertiary">{t('sendFirstMessage').replace('{handle}', otherUser?.handle || `User ${otherUser?.id.slice(0, 8)}`)}</Text>
            </Box>
          </Box>
        )}
        
        <div ref={messagesEndRef} />
      </Box>

      {/* Overlays */}
      {conversationId && accessToken && (
        <ChatSearchOverlay isOpen={searchOpen} onClose={() => setSearchOpen(false)} conversationId={conversationId} accessToken={accessToken}
          onNavigateToMessage={(messageId) => { setSearchOpen(false); setTimeout(() => navigateToMessage(messageId), 100) }}
        />
      )}
      {otherUser && conversationId && accessToken && (
        <ChatSettingsDrawer isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} conversationId={conversationId}
          otherUser={{ id: otherUser.id, handle: otherUser.handle || null, avatar_url: otherUser.avatar_url ?? undefined, bio: otherUser.bio ?? undefined }}
          accessToken={accessToken}
          onSettingsChange={(newSettings) => { setRemark(newSettings.remark); if (newSettings.cleared_before) setClearedBefore(newSettings.cleared_before) }}
          onSearchOpen={() => setSearchOpen(true)}
          onClearHistory={() => { setClearedBefore(new Date().toISOString()) }}
        />
      )}
      {previewOpen && <MediaPreview preview={previewOpen} onClose={() => setPreviewOpen(null)} t={t} />}

      <style>{`.msg-bubble:hover + .msg-timestamp, .msg-timestamp:hover { opacity: 1 !important; } div:hover > .msg-timestamp { opacity: 1 !important; } .msg-bubble { position: relative; }`}</style>

      <MessageInput
        newMessage={newMessage} setNewMessage={setNewMessage}
        pendingAttachment={pendingAttachment} setPendingAttachment={setPendingAttachment}
        sending={sending} uploading={uploading} setUploading={setUploading}
        userId={userId} conversationId={conversationId}
        showStickerPicker={showStickerPicker} setShowStickerPicker={setShowStickerPicker}
        onSend={handleSend} onVoiceSent={handleVoiceSent}
        onPreviewOpen={setPreviewOpen} showToast={showToast}
        t={t} language={language} inputRef={inputRef}
      />
    </Box>
  )
}
