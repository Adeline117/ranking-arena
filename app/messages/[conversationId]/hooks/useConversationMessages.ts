'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  MessageErrorCode,
  getAuthSession,
  refreshAuthToken,
  resolveErrorCode,
  getErrorMessage,
} from '@/lib/auth'
import { useRealtime } from '@/lib/hooks/useRealtime'
import { getCsrfHeaders } from '@/lib/api/client'
import { getMediaTypeLabel, updateMessageStatus, groupMessagesByDate } from '../components/types'
import type { Message, MediaAttachment, OtherUser, MessageStatus } from '../components/types'
import { getLocaleFromLanguage } from '@/lib/utils/format'

interface UseConversationMessagesOptions {
  conversationId: string
  userId: string | null
  accessToken: string | null
}

export function useConversationMessages({ conversationId, userId, accessToken }: UseConversationMessagesOptions) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const [messages, setMessages] = useState<Message[]>([])
  const [otherUser, setOtherUser] = useState<OtherUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>('connected')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isLoadingOlderRef = useRef(false)
  const prevMessageCountRef = useRef(0)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref from useLanguage
  }, [conversationId, accessToken, loadingMore, hasMore, messages, showToast])

  // Realtime: incoming messages
  useRealtime<Message>({
    table: 'direct_messages', event: 'INSERT',
    filter: otherUser ? `sender_id=eq.${otherUser.id}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true, maxRetries: 10,
    onInsert: (newMsg) => {
      if (newMsg.receiver_id === userId) {
        setMessages(prev => { if (prev.some(m => m.id === newMsg.id)) return prev; return [...prev, newMsg] })
        if (accessToken && conversationId) {
          fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }, body: JSON.stringify({ conversationId }) }).catch(err => console.warn('[useConversationMessages] mark-read failed', err))
        }
      }
    },
    onStatusChange: (status) => {
      if (status === 'connected') setConnectionStatus('connected')
      else if (status === 'disconnected' || status === 'error') setConnectionStatus('disconnected')
      else if (status === 'reconnecting') setConnectionStatus('reconnecting')
    },
  })

  // Realtime: read receipts
  useRealtime<Message>({
    table: 'direct_messages', event: 'UPDATE',
    filter: userId ? `sender_id=eq.${userId}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true, maxRetries: 5,
    onUpdate: ({ new: updatedMsg }) => {
      if (updatedMsg.read) { setMessages(prev => prev.map(m => m.id === updatedMsg.id ? { ...m, read: true, read_at: updatedMsg.read_at } : m)) }
    },
  })

  // Send message helper
  const sendMessageRequest = async (receiverId: string, content: string, token: string, attachment?: MediaAttachment | null) => {
    const body: Record<string, unknown> = { receiverId, content }
    if (attachment) { body.media_url = attachment.url; body.media_type = attachment.type; body.media_name = attachment.originalName }
    const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...getCsrfHeaders() }, body: JSON.stringify(body) })
    const data = await res.json()
    return { ok: res.ok, status: res.status, data }
  }

  const handleSend = useCallback(async (content: string, pendingAttachment: MediaAttachment | null): Promise<void> => {
    if (!userId || !otherUser) return
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
    setMessages(prev => [...prev, optimisticMessage])

    try {
      let result = await sendMessageRequest(otherUser.id, optimisticMessage.content, auth.accessToken, pendingAttachment)
      if (result.status === 401) {
        const refreshed = await refreshAuthToken()
        if (refreshed) { result = await sendMessageRequest(otherUser.id, optimisticMessage.content, refreshed.accessToken, pendingAttachment) }
        else { const ec = MessageErrorCode.NOT_AUTHENTICATED; setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, getErrorMessage(ec))); showToast(t('loginExpiredPleaseRelogin'), 'error'); return }
      }
      if (!result.ok) {
        const ec = resolveErrorCode(result.status, result.data as { error_code?: string; error?: string }); const em = getErrorMessage(ec, result.data.error as string)
        setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, em)); showToast(em, 'error'); return
      }
      if (result.data.message) { setMessages(prev => prev.map(m => m._tempId === tempId ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus } : m)) }
    } catch { const ec = MessageErrorCode.NETWORK_ERROR; const em = getErrorMessage(ec); setMessages(prev => updateMessageStatus(prev, tempId, true, 'failed', ec, em)); showToast(em, 'error') }
  }, [userId, otherUser, showToast, t, router])

  const handleRetry = useCallback(async (failedMsg: Message) => {
    if (!otherUser) return
    const auth = await getAuthSession()
    if (!auth) { const refreshed = await refreshAuthToken(); if (!refreshed) { showToast(t('loginExpiredPleaseRelogin'), 'error'); router.push('/login?redirect=/inbox'); return } }
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
  }, [otherUser, showToast, t, router])

  const handleVoiceSent = useCallback(async (voiceUrl: string, duration: number) => {
    if (!userId || !otherUser) return
    const content = `[Voice] ${t('voiceMessage')} (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`
    const auth = await getAuthSession()
    if (!auth) return
    const tempId = `voice-${Date.now()}`
    const attachment: MediaAttachment = { url: voiceUrl, type: 'file', fileName: 'voice-message.webm', originalName: 'voice-message.webm' }
    const tempMsg: Message = {
      id: tempId, sender_id: userId, receiver_id: otherUser.id, content, read: false, created_at: new Date().toISOString(),
      media_url: voiceUrl, media_type: 'file', media_name: 'voice-message.webm', _status: 'sending', _tempId: tempId, _attachment: attachment,
    }
    setMessages(prev => [...prev, tempMsg])
    try {
      const result = await sendMessageRequest(otherUser.id, content, auth.accessToken, attachment)
      if (result.ok && result.data.message) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus } : m))
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m))
      }
    } catch { setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m)) }
  }, [userId, otherUser, t])

  const navigateToMessage = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId)
    const el = messageRefs.current[messageId]
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => setHighlightedMessageId(null), 2000) }
  }, [])

  const formatTime = useCallback((dateString: string) => {
    return new Date(dateString).toLocaleTimeString(getLocaleFromLanguage(language), { hour: '2-digit', minute: '2-digit' })
  }, [language])

  const formatDate = useCallback((dateString: string) => {
    const date = new Date(dateString); const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === today.toDateString()) return t('today')
    if (date.toDateString() === yesterday.toDateString()) return t('yesterday')
    return date.toLocaleDateString(getLocaleFromLanguage(language), { month: 'long', day: 'numeric' })
  }, [language, t])

  const handleDeleteMessage = useCallback(async (msgId: string) => {
    if (!accessToken) return
    const snapshot = messages
    setMessages(msgs => msgs.filter(m => m.id !== msgId))
    try {
      const res = await fetch(`/api/messages/${msgId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      if (!res.ok) {
        setMessages(snapshot)
        showToast(t('operationFailed'), 'error')
      }
    } catch {
      setMessages(snapshot)
      showToast(t('operationFailed'), 'error')
    }
  }, [accessToken, messages, showToast, t])

  return {
    messages, setMessages, otherUser, loading, loadingMore, hasMore, connectionStatus,
    messagesEndRef, messageRefs, highlightedMessageId,
    loadMessages, loadOlderMessages, handleSend, handleRetry, handleVoiceSent, handleDeleteMessage,
    navigateToMessage, scrollToBottom, formatTime, formatDate, groupMessagesByDate,
  }
}
