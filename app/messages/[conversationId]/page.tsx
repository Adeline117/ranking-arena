'use client'

import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePresence } from '@/lib/hooks/usePresence'
import ChatSettingsDrawer from '@/app/components/features/ChatSettingsDrawer'
import ChatSearchOverlay from '@/app/components/features/ChatSearchOverlay'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

import type { Message } from './components/types'
import ConversationHeader from './components/ConversationHeader'
import MessageBubble from './components/MessageBubble'
import MessageInput from './components/MessageInput'
import MediaPreview from './components/MediaPreview'

import { useConversationAuth } from './hooks/useConversationAuth'
import { useConversationMessages } from './hooks/useConversationMessages'
import { useFileUpload } from './hooks/useFileUpload'

export default function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  if (!features.social) notFound()

  const { t, language } = useLanguage()
  const [conversationId, setConversationId] = useState<string>('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [remark, setRemark] = useState<string | null>(null)
  const [clearedBefore, setClearedBefore] = useState<string | null>(null)
  const [showStickerPicker, setShowStickerPicker] = useState(false)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [previewOpen, setPreviewOpen] = useState<{ type: 'image' | 'video' | 'file'; url: string; fileName?: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isTypingRef = useRef(false)

  // Auth hook
  const { email, userId, authChecked, accessToken } = useConversationAuth()

  // Messages hook
  const msgHook = useConversationMessages({ conversationId, userId, accessToken })

  // File upload hook
  const fileHook = useFileUpload({ userId, conversationId })

  // Online presence
  const watchIds = msgHook.otherUser ? [msgHook.otherUser.id] : []
  const { getUserPresence, setTyping, isUserTyping } = usePresence(userId, watchIds)
  const otherPresence = msgHook.otherUser ? getUserPresence(msgHook.otherUser.id) : null
  const otherIsTyping = msgHook.otherUser && conversationId ? isUserTyping(msgHook.otherUser.id, conversationId) : false

  // Typing indicator
  const handleTypingChange = useCallback((text: string) => {
    setNewMessage(text)
    if (!conversationId) return
    if (text.trim()) {
      // Only send track() when transitioning from not-typing to typing
      if (!isTypingRef.current) {
        isTypingRef.current = true
        setTyping(conversationId, true)
      }
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => { isTypingRef.current = false; setTyping(conversationId, false) }, 3000)
    } else {
      isTypingRef.current = false
      setTyping(conversationId, false)
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    }
  }, [conversationId, setTyping])

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      if (conversationId) { isTypingRef.current = false; setTyping(conversationId, false) }
    }
  }, [conversationId, setTyping])

  // Mark as read on open
  useEffect(() => {
    if (!conversationId || !accessToken) return
    fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
      body: JSON.stringify({ conversationId }),
    }).catch(err => console.warn('[Messages] fetch failed', err))
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

  // Resolve params
  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ conversationId: string }>).then(resolved => { setConversationId(resolved.conversationId) })
    } else {
      setConversationId(String((params as { conversationId: string })?.conversationId ?? ''))
    }
  }, [params])

  // Load messages when auth + conversationId ready
  useEffect(() => {
    if (userId && conversationId && accessToken) {
      msgHook.loadMessages(userId, conversationId, accessToken)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- msgHook.loadMessages is stable, excluding to avoid infinite loop
  }, [conversationId, userId, accessToken])

  // Load settings
  useEffect(() => {
    if (!conversationId || !accessToken) return
    fetch(`/api/chat/${conversationId}/settings`, { headers: { 'Authorization': `Bearer ${accessToken}` } })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.settings) { setRemark(data.settings.remark || null); setClearedBefore(data.settings.cleared_before || null) } })
      .catch(err => console.warn('[Messages] fetch failed', err))
  }, [conversationId, accessToken])

  // Send handler
  const handleSend = async () => {
    const hasContent = newMessage.trim() || fileHook.pendingAttachment
    if (!hasContent || sending) return
    setSending(true)
    const content = newMessage.trim()
    setNewMessage('')
    const attachment = fileHook.pendingAttachment
    fileHook.setPendingAttachment(null)
    inputRef.current?.focus()
    if (conversationId) { isTypingRef.current = false; setTyping(conversationId, false); if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current) }
    await msgHook.handleSend(content, attachment)
    setSending(false)
  }

  // Auth / loading states
  if (!authChecked || (authChecked && !userId && msgHook.loading)) {
    return (<Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}><TopNav email={email} /><Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Box key={i} style={{ display: 'flex', alignItems: i % 2 === 0 ? 'flex-end' : 'flex-start', flexDirection: 'column', gap: 4 }}>
          <Box style={{ width: `${30 + Math.random() * 40}%`, height: 40, borderRadius: 16, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
        </Box>
      ))}
    </Box></Box>)
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
            <Link href="/login" style={{ display: 'inline-block', padding: '12px 24px', background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, var(--color-brand-hover) 100%)`, color: tokens.colors.white, borderRadius: tokens.radius.lg, textDecoration: 'none', fontWeight: 700, fontSize: '14px' }}>{t('goToLogin')}</Link>
          </Box>
        </Box>
      </Box>
    )
  }
  if (msgHook.loading) {
    return (<Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}><TopNav email={email} /><Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
      {[1, 2, 3, 4, 5, 6].map(i => (
        <Box key={i} style={{ display: 'flex', alignItems: i % 2 === 0 ? 'flex-end' : 'flex-start', flexDirection: 'column', gap: 4 }}>
          <Box style={{ width: `${25 + (i * 7) % 35}%`, height: 36 + (i % 3) * 8, borderRadius: 16, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
        </Box>
      ))}
    </Box></Box>)
  }

  const visibleMessages = clearedBefore ? msgHook.messages.filter(msg => new Date(msg.created_at) > new Date(clearedBefore)) : msgHook.messages
  const messageGroups = msgHook.groupMessagesByDate(visibleMessages)

  return (
    <Box
      onDragOver={fileHook.handleDragOver}
      onDragLeave={fileHook.handleDragLeave}
      onDrop={fileHook.handleDrop}
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary} 50%, ${tokens.colors.bg.primary} 100%)`,
        color: tokens.colors.text.primary, display: 'flex', flexDirection: 'column', position: 'relative',
      }}
    >
      {fileHook.isDragging && (
        <Box style={{ position: 'absolute', inset: 0, zIndex: 999, background: 'var(--color-accent-primary-15)', border: `3px dashed ${tokens.colors.accent.brand}`, borderRadius: tokens.radius.lg, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.brand }}>{t('dragDropHint')}</Text>
        </Box>
      )}
      <TopNav email={email} />
      
      <ConversationHeader
        otherUser={msgHook.otherUser}
        userId={userId}
        remark={remark}
        otherPresence={otherPresence}
        connectionStatus={msgHook.connectionStatus}
        email={email}
        onSettingsOpen={() => setSettingsOpen(true)}
        onSearchOpen={() => setSearchOpen(true)}
        t={t}
      />

      {/* Messages Area */}
      <Box style={{ flex: 1, overflow: 'auto', padding: `${tokens.spacing[4]} ${tokens.spacing[4]} ${tokens.spacing[6]}`, maxWidth: 800, margin: '0 auto', width: '100%' }}>
        {msgHook.hasMore && (
          <Box style={{ textAlign: 'center', marginBottom: 12 }}>
            <button onClick={msgHook.loadOlderMessages} disabled={msgHook.loadingMore} style={{ padding: '6px 16px', background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.xl, color: tokens.colors.text.secondary, fontSize: 13, cursor: msgHook.loadingMore ? 'not-allowed' : 'pointer', opacity: msgHook.loadingMore ? 0.6 : 1, transition: 'opacity 0.2s' }}>
              {msgHook.loadingMore ? t('loading') : t('loadOlderMessages')}
            </button>
          </Box>
        )}

        {messageGroups.map((group, groupIndex) => (
          <Box key={groupIndex}>
            <Box style={{ textAlign: 'center', margin: `${tokens.spacing[5]} 0`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing[3] }}>
              <Box style={{ flex: 1, height: 1, background: `linear-gradient(to right, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
              <Text size="xs" color="tertiary" style={{ fontSize: 11, letterSpacing: '0.5px', fontWeight: 600 }}>{msgHook.formatDate(group.date)}</Text>
              <Box style={{ flex: 1, height: 1, background: `linear-gradient(to left, transparent, ${tokens.colors.border.primary})`, maxWidth: 80 }} />
            </Box>
            
            {group.messages.map((msg: Message, msgIndex: number) => {
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
                  otherUser={msgHook.otherUser}
                  userId={userId}
                  highlightedMessageId={msgHook.highlightedMessageId}
                  onRetry={msgHook.handleRetry}
                  onDelete={msgHook.handleDeleteMessage}
                  onPreviewOpen={setPreviewOpen}
                  formatTime={msgHook.formatTime}
                  t={t}
                  messageRef={(el) => { msgHook.messageRefs.current[msg.id] = el }}
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
              <Text size="sm" color="tertiary">{t('sendFirstMessage').replace('{handle}', msgHook.otherUser?.handle || `User ${msgHook.otherUser?.id.slice(0, 8)}`)}</Text>
            </Box>
          </Box>
        )}
        
        <div ref={msgHook.messagesEndRef} />
      </Box>

      {/* Overlays */}
      {conversationId && accessToken && (
        <ChatSearchOverlay isOpen={searchOpen} onClose={() => setSearchOpen(false)} conversationId={conversationId} accessToken={accessToken}
          onNavigateToMessage={(messageId) => { setSearchOpen(false); setTimeout(() => msgHook.navigateToMessage(messageId), 100) }}
        />
      )}
      {msgHook.otherUser && conversationId && accessToken && (
        <ChatSettingsDrawer isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} conversationId={conversationId}
          otherUser={{ id: msgHook.otherUser.id, handle: msgHook.otherUser.handle || null, avatar_url: msgHook.otherUser.avatar_url ?? undefined, bio: msgHook.otherUser.bio ?? undefined }}
          accessToken={accessToken}
          onSettingsChange={(newSettings) => { setRemark(newSettings.remark); if (newSettings.cleared_before) setClearedBefore(newSettings.cleared_before) }}
          onSearchOpen={() => setSearchOpen(true)}
          onClearHistory={() => { setClearedBefore(new Date().toISOString()) }}
        />
      )}
      {previewOpen && <MediaPreview preview={previewOpen} onClose={() => setPreviewOpen(null)} t={t} />}

      <style>{`.msg-bubble:hover + .msg-timestamp, .msg-timestamp:hover { opacity: 1 !important; } div:hover > .msg-timestamp { opacity: 1 !important; } .msg-bubble { position: relative; }`}</style>

      {/* Typing indicator */}
      {otherIsTyping && (
        <Box style={{ padding: `${tokens.spacing[1]} ${tokens.spacing[4]}`, maxWidth: 800, margin: '0 auto', width: '100%' }}>
          <Text size="xs" color="tertiary" style={{ fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: tokens.colors.text.tertiary, animation: 'typingDot 1.4s infinite', animationDelay: '0s' }} />
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: tokens.colors.text.tertiary, animation: 'typingDot 1.4s infinite', animationDelay: '0.2s' }} />
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: tokens.colors.text.tertiary, animation: 'typingDot 1.4s infinite', animationDelay: '0.4s' }} />
            </span>
            {t('typing')}
          </Text>
        </Box>
      )}
      <style>{`@keyframes typingDot { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }`}</style>

      <MessageInput
        newMessage={newMessage} setNewMessage={handleTypingChange}
        pendingAttachment={fileHook.pendingAttachment} setPendingAttachment={fileHook.setPendingAttachment}
        sending={sending} uploading={fileHook.uploading} setUploading={fileHook.setUploading}
        userId={userId} conversationId={conversationId}
        showStickerPicker={showStickerPicker} setShowStickerPicker={setShowStickerPicker}
        onSend={handleSend} onVoiceSent={msgHook.handleVoiceSent}
        onPreviewOpen={setPreviewOpen} showToast={() => {}}
        t={t} language={language} inputRef={inputRef}
      />
    </Box>
  )
}
