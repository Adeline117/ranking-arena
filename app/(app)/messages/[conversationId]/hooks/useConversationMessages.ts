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
import {
  getMediaTypeLabel,
  updateMessageStatus,
  groupMessagesByDate,
  applyReactionDelta,
} from '../components/types'
import type {
  Message,
  MediaAttachment,
  OtherUser,
  MessageStatus,
  MessageReaction,
} from '../components/types'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { buildConversationLoginHref } from '../login-intent'

interface UseConversationMessagesOptions {
  conversationId: string
  userId: string | null
  accessToken: string | null
}

// Realtime starts in a 'disconnected' state and briefly reports it before the
// initial subscribe completes. Suppress the alarming "connection lost" banner
// during this first-connect window so opening a conversation doesn't flash a
// false disconnect (U11-10). Only surface a real disconnect once we've
// connected at least once, or after this grace period elapses without connecting.
const FIRST_CONNECT_GRACE_MS = 5000

export function useConversationMessages({
  conversationId,
  userId,
  accessToken,
}: UseConversationMessagesOptions) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const loginHref = buildConversationLoginHref(conversationId)
  const [messages, setMessages] = useState<Message[]>([])
  const [otherUser, setOtherUser] = useState<OtherUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<
    'connected' | 'disconnected' | 'reconnecting'
  >('connected')
  // First-connect grace tracking (see FIRST_CONNECT_GRACE_MS).
  const hasConnectedRef = useRef(false)
  const graceExpiredRef = useRef(false)
  // True while we should hold the optimistic "connected" state: never connected
  // yet AND still inside the grace window.
  const inFirstConnectGrace = () => !hasConnectedRef.current && !graceExpiredRef.current
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isLoadingOlderRef = useRef(false)
  const prevMessageCountRef = useRef(0)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null)
  // Reply / quote: the message currently being replied to (null = not replying)
  const [replyingTo, setReplyingTo] = useState<Message | null>(null)
  // Guard against state updates after unmount for realtime callbacks (CLAUDE.md)
  const mountedRef = useRef(true)
  // Maps reaction row id -> {messageId, emoji, userId} so DELETE events (which only
  // carry the PK under default replica identity) can be resolved back to a message.
  const reactionRowMapRef = useRef<
    Map<string, { messageId: string; emoji: string; userId: string }>
  >(new Map())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => {
    if (isLoadingOlderRef.current) {
      isLoadingOlderRef.current = false
      prevMessageCountRef.current = messages.length
      return
    }
    if (messages.length > 0) {
      scrollToBottom(prevMessageCountRef.current === 0 ? 'instant' : 'smooth')
    }
    prevMessageCountRef.current = messages.length
  }, [messages, scrollToBottom])

  const loadMessages = useCallback(
    async (uid: string, convId: string, token?: string) => {
      try {
        setLoading(true)
        let authToken = token
        if (!authToken) {
          const auth = await getAuthSession()
          if (!auth) {
            showToast(t('pleaseLogin'), 'error')
            router.push(loginHref)
            return
          }
          authToken = auth.accessToken
        }
        const res = await fetch(`/api/messages?conversationId=${convId}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        })
        if (res.status === 401) {
          const refreshed = await refreshAuthToken()
          if (refreshed) {
            const retryRes = await fetch(`/api/messages?conversationId=${convId}`, {
              headers: { Authorization: `Bearer ${refreshed.accessToken}` },
            })
            const retryData = await retryRes.json()
            if (retryRes.ok && retryData.messages) {
              setMessages(retryData.messages)
              if (retryData.otherUser) setOtherUser(retryData.otherUser)
              return
            }
          }
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          router.push(loginHref)
          return
        }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          // 404/403 = the conversation doesn't exist or isn't ours (bad/stale link):
          // show a specific "gone" message instead of a generic failure, then send
          // the user back to their inbox rather than silently bouncing (U10-9).
          const isGone = res.status === 404 || res.status === 403
          showToast(
            isGone ? t('u10inbox_conversationGone') : data.error || t('loadMessagesFailed'),
            'error'
          )
          router.push('/inbox?tab=messages&chat=direct')
          return
        }
        if (data.messages) {
          setMessages(data.messages)
          if (data.otherUser) setOtherUser(data.otherUser)
        }
      } catch {
        showToast(t('networkErrorLoadMessages'), 'error')
      } finally {
        setLoading(false)
      }
    },
    [showToast, router, t, loginHref]
  )

  const loadOlderMessages = useCallback(async () => {
    if (!conversationId || !accessToken || loadingMore || !hasMore) return
    const oldest = messages.find((m) => !m._tempId)
    if (!oldest) return
    setLoadingMore(true)
    try {
      const res = await fetch(
        `/api/messages?conversationId=${conversationId}&before=${oldest.created_at}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      const data = await res.json()
      if (data.messages?.length) {
        isLoadingOlderRef.current = true
        setMessages((prev) => [...data.messages, ...prev])
        setHasMore(!!data.has_more)
      } else {
        setHasMore(false)
      }
    } catch {
      showToast(t('loadOlderMessagesFailed'), 'error')
    } finally {
      setLoadingMore(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is a stable ref from useLanguage
  }, [conversationId, accessToken, loadingMore, hasMore, messages, showToast])

  // Realtime: incoming messages
  useRealtime<Message>({
    table: 'direct_messages',
    event: 'INSERT',
    filter: otherUser ? `sender_id=eq.${otherUser.id}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true,
    maxRetries: 10,
    onInsert: (newMsg) => {
      if (newMsg.receiver_id === userId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) return prev
          return [...prev, newMsg]
        })
        if (accessToken && conversationId) {
          fetch('/api/messages/read', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ conversationId }),
          }).catch((err) => console.warn('[useConversationMessages] mark-read failed', err))
        }
      }
    },
    onStatusChange: (status) => {
      if (status === 'connected') {
        hasConnectedRef.current = true
        setConnectionStatus('connected')
      } else if (status === 'disconnected' || status === 'error') {
        // Hold optimistic "connected" while inside the first-connect grace window.
        if (inFirstConnectGrace()) return
        setConnectionStatus('disconnected')
      } else if (status === 'reconnecting') {
        if (inFirstConnectGrace()) return
        setConnectionStatus('reconnecting')
      }
    },
  })

  // Realtime: read receipts
  useRealtime<Message>({
    table: 'direct_messages',
    event: 'UPDATE',
    filter: userId ? `sender_id=eq.${userId}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true,
    maxRetries: 5,
    onUpdate: ({ new: updatedMsg }) => {
      if (updatedMsg.read) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === updatedMsg.id ? { ...m, read: true, read_at: updatedMsg.read_at } : m
          )
        )
      }
    },
  })

  // First-connect grace: reset per conversation, then after the grace window
  // stop suppressing disconnect state. If we never connected, surface the real
  // disconnect banner (covers a silent connect failure that emits no further
  // status change). onStatusChange handles the normal case earlier.
  useEffect(() => {
    hasConnectedRef.current = false
    graceExpiredRef.current = false
    const id = setTimeout(() => {
      graceExpiredRef.current = true
      if (!hasConnectedRef.current && mountedRef.current) {
        setConnectionStatus('disconnected')
      }
    }, FIRST_CONNECT_GRACE_MS)
    return () => clearTimeout(id)
  }, [conversationId])

  // Realtime: emoji reactions (INSERT). RLS limits delivery to the 2 participants,
  // so we only need to match the affected message to one already in view.
  useRealtime<{ id: string; message_id: string; user_id: string; emoji: string }>({
    table: 'message_reactions',
    event: 'INSERT',
    enabled: !!userId && !!conversationId,
    autoReconnect: true,
    maxRetries: 5,
    onInsert: (row) => {
      if (!mountedRef.current) return
      reactionRowMapRef.current.set(row.id, {
        messageId: row.message_id,
        emoji: row.emoji,
        userId: row.user_id,
      })
      // Our own reactions are already applied optimistically via handleToggleReaction.
      if (row.user_id === userId) return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === row.message_id
            ? { ...m, reactions: applyReactionDelta(m.reactions, row.emoji, 1, false) }
            : m
        )
      )
    },
  })

  // Realtime: emoji reactions (DELETE). Default replica identity only sends the PK,
  // so resolve message/emoji via the row map populated on INSERT.
  useRealtime<{ id: string }>({
    table: 'message_reactions',
    event: 'DELETE',
    enabled: !!userId && !!conversationId,
    autoReconnect: true,
    maxRetries: 5,
    onDelete: (row) => {
      if (!mountedRef.current) return
      const info = reactionRowMapRef.current.get(row.id)
      reactionRowMapRef.current.delete(row.id)
      if (!info || info.userId === userId) return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === info.messageId
            ? { ...m, reactions: applyReactionDelta(m.reactions, info.emoji, -1) }
            : m
        )
      )
    },
  })

  // Send message helper
  const sendMessageRequest = async (
    receiverId: string,
    content: string,
    token: string,
    attachment?: MediaAttachment | null,
    replyToId?: string | null
  ) => {
    const body: Record<string, unknown> = { receiverId, content }
    if (attachment) {
      body.media_url = attachment.url
      body.media_type = attachment.type
      body.media_name = attachment.originalName
    }
    if (replyToId) {
      body.reply_to_id = replyToId
    }
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return { ok: res.ok, status: res.status, data }
  }

  const handleSend = useCallback(
    async (content: string, pendingAttachment: MediaAttachment | null): Promise<void> => {
      if (!userId || !otherUser) return
      if (content.length > 2000) {
        showToast(t('messageTooLong'), 'warning')
        return
      }
      const auth = await getAuthSession()
      if (!auth) {
        showToast(t('pleaseLogin'), 'error')
        router.push(loginHref)
        return
      }

      // Snapshot + clear the reply target so the composer resets immediately
      const replyTo = replyingTo
      setReplyingTo(null)

      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticMessage: Message = {
        id: tempId,
        sender_id: userId,
        receiver_id: otherUser.id,
        content:
          content || (pendingAttachment ? `[${getMediaTypeLabel(pendingAttachment.type, t)}]` : ''),
        read: false,
        created_at: new Date().toISOString(),
        _status: 'sending',
        _tempId: tempId,
        _attachment: pendingAttachment || undefined,
        media_url: pendingAttachment?.url,
        media_type: pendingAttachment?.type,
        media_name: pendingAttachment?.originalName,
        reply_to_id: replyTo?.id ?? null,
        reply_preview: replyTo
          ? { sender_id: replyTo.sender_id, content: (replyTo.content || '').slice(0, 120) }
          : null,
      }
      setMessages((prev) => [...prev, optimisticMessage])

      try {
        let result = await sendMessageRequest(
          otherUser.id,
          optimisticMessage.content,
          auth.accessToken,
          pendingAttachment,
          replyTo?.id
        )
        if (result.status === 401) {
          const refreshed = await refreshAuthToken()
          if (refreshed) {
            result = await sendMessageRequest(
              otherUser.id,
              optimisticMessage.content,
              refreshed.accessToken,
              pendingAttachment,
              replyTo?.id
            )
          } else {
            const ec = MessageErrorCode.NOT_AUTHENTICATED
            setMessages((prev) =>
              updateMessageStatus(prev, tempId, true, 'failed', ec, getErrorMessage(ec))
            )
            showToast(t('loginExpiredPleaseRelogin'), 'error')
            return
          }
        }
        if (!result.ok) {
          const ec = resolveErrorCode(
            result.status,
            result.data as { error_code?: string; error?: string }
          )
          const em = getErrorMessage(ec, result.data.error as string)
          setMessages((prev) => updateMessageStatus(prev, tempId, true, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        if (result.data.message) {
          setMessages((prev) =>
            prev.map((m) =>
              m._tempId === tempId
                ? {
                    ...(result.data.message as Message),
                    reply_preview: optimisticMessage.reply_preview,
                    _status: 'sent' as MessageStatus,
                  }
                : m
            )
          )
        }
      } catch {
        const ec = MessageErrorCode.NETWORK_ERROR
        const em = getErrorMessage(ec)
        setMessages((prev) => updateMessageStatus(prev, tempId, true, 'failed', ec, em))
        showToast(em, 'error')
      }
    },
    [userId, otherUser, showToast, t, router, replyingTo, loginHref]
  )

  const handleRetry = useCallback(
    async (failedMsg: Message) => {
      if (!otherUser) return
      const auth = await getAuthSession()
      if (!auth) {
        const refreshed = await refreshAuthToken()
        if (!refreshed) {
          showToast(t('loginExpiredPleaseRelogin'), 'error')
          router.push(loginHref)
          return
        }
      }
      const currentAuth = auth || (await getAuthSession())
      if (!currentAuth) {
        showToast(t('pleaseLogin'), 'error')
        router.push(loginHref)
        return
      }
      setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'sending'))
      try {
        let result = await sendMessageRequest(
          otherUser.id,
          failedMsg.content,
          currentAuth.accessToken,
          failedMsg._attachment
        )
        if (result.status === 401) {
          const refreshed = await refreshAuthToken()
          if (refreshed) {
            result = await sendMessageRequest(
              otherUser.id,
              failedMsg.content,
              refreshed.accessToken,
              failedMsg._attachment
            )
          } else {
            const ec = MessageErrorCode.NOT_AUTHENTICATED
            setMessages((prev) =>
              updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, getErrorMessage(ec))
            )
            showToast(t('loginExpiredPleaseRelogin'), 'error')
            return
          }
        }
        if (!result.ok) {
          const ec = resolveErrorCode(
            result.status,
            result.data as { error_code?: string; error?: string }
          )
          const em = getErrorMessage(ec, result.data.error as string)
          setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        if (result.data.message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === failedMsg.id
                ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus }
                : m
            )
          )
        }
      } catch {
        const ec = MessageErrorCode.NETWORK_ERROR
        const em = getErrorMessage(ec)
        setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em))
        showToast(em, 'error')
      }
    },
    [otherUser, showToast, t, router, loginHref]
  )

  const handleVoiceSent = useCallback(
    async (voiceUrl: string, duration: number) => {
      if (!userId || !otherUser) return
      const content = `[Voice] ${t('voiceMessage')} (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`
      const auth = await getAuthSession()
      if (!auth) return
      const tempId = `voice-${Date.now()}`
      const attachment: MediaAttachment = {
        url: voiceUrl,
        type: 'file',
        fileName: 'voice-message.webm',
        originalName: 'voice-message.webm',
      }
      const tempMsg: Message = {
        id: tempId,
        sender_id: userId,
        receiver_id: otherUser.id,
        content,
        read: false,
        created_at: new Date().toISOString(),
        media_url: voiceUrl,
        media_type: 'file',
        media_name: 'voice-message.webm',
        _status: 'sending',
        _tempId: tempId,
        _attachment: attachment,
      }
      setMessages((prev) => [...prev, tempMsg])
      try {
        const result = await sendMessageRequest(otherUser.id, content, auth.accessToken, attachment)
        if (result.ok && result.data.message) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === tempId
                ? { ...(result.data.message as Message), _status: 'sent' as MessageStatus }
                : m
            )
          )
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m))
          )
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m))
        )
      }
    },
    [userId, otherUser, t]
  )

  const navigateToMessage = useCallback((messageId: string) => {
    setHighlightedMessageId(messageId)
    const el = messageRefs.current[messageId]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => setHighlightedMessageId(null), 2000)
    }
  }, [])

  const formatTime = useCallback(
    (dateString: string) => {
      return new Date(dateString).toLocaleTimeString(getLocaleFromLanguage(language), {
        hour: '2-digit',
        minute: '2-digit',
      })
    },
    [language]
  )

  const formatDate = useCallback(
    (dateString: string) => {
      const date = new Date(dateString)
      const today = new Date()
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      if (date.toDateString() === today.toDateString()) return t('today')
      if (date.toDateString() === yesterday.toDateString()) return t('yesterday')
      return date.toLocaleDateString(getLocaleFromLanguage(language), {
        month: 'long',
        day: 'numeric',
      })
    },
    [language, t]
  )

  const handleDeleteMessage = useCallback(
    async (msgId: string) => {
      if (!accessToken) return
      // Capture snapshot via functional updater to avoid stale closure over messages
      let snapshot: Message[] = []
      setMessages((prev) => {
        snapshot = prev
        return prev.filter((m) => m.id !== msgId)
      })
      try {
        const res = await fetch(`/api/messages/${msgId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() },
        })
        if (!res.ok) {
          setMessages(snapshot)
          showToast(t('operationFailed'), 'error')
        }
      } catch {
        setMessages(snapshot)
        showToast(t('operationFailed'), 'error')
      }
    },
    [accessToken, showToast, t]
  )

  // Toggle an emoji reaction on a message — delta-based optimistic update + rollback.
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId) return
      const auth = await getAuthSession()
      if (!auth) {
        showToast(t('pleaseLogin'), 'error')
        router.push(loginHref)
        return
      }

      // Optimistic delta (capture prior "mine" state inside the synchronous updater)
      let wasMine = false
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          wasMine = !!m.reactions?.find((r) => r.emoji === emoji)?.mine
          return {
            ...m,
            reactions: applyReactionDelta(m.reactions, emoji, wasMine ? -1 : 1, !wasMine),
          }
        })
      )

      try {
        const res = await fetch(`/api/messages/${messageId}/react`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ emoji }),
        })
        const data = await res.json()
        if (res.ok && data.success) {
          // Reconcile with server truth
          const counts = (data.data.counts || {}) as Record<string, number>
          const userEmojis = new Set((data.data.userEmojis || []) as string[])
          const reactions: MessageReaction[] = Object.entries(counts)
            .filter(([, c]) => c > 0)
            .map(([e, c]) => ({ emoji: e, count: c, mine: userEmojis.has(e) }))
          setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)))
        } else {
          throw new Error('react failed')
        }
      } catch {
        // Rollback the optimistic delta
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? {
                  ...m,
                  reactions: applyReactionDelta(m.reactions, emoji, wasMine ? 1 : -1, wasMine),
                }
              : m
          )
        )
        showToast(t('operationFailed'), 'error')
      }
    },
    [userId, showToast, t, router, loginHref]
  )

  return {
    messages,
    setMessages,
    otherUser,
    loading,
    loadingMore,
    hasMore,
    connectionStatus,
    messagesEndRef,
    messageRefs,
    highlightedMessageId,
    replyingTo,
    setReplyingTo,
    handleToggleReaction,
    loadMessages,
    loadOlderMessages,
    handleSend,
    handleRetry,
    handleVoiceSent,
    handleDeleteMessage,
    navigateToMessage,
    scrollToBottom,
    formatTime,
    formatDate,
    groupMessagesByDate,
  }
}
