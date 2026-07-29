'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { MessageErrorCode, resolveErrorCode, getErrorMessage } from '@/lib/auth'
import { useRealtime } from '@/lib/hooks/useRealtime'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '@/app/(app)/settings/hooks/settings-viewer-scope'
import {
  DM_REACTION_EMOJIS,
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

type ConversationOperation = {
  controller: AbortController
  conversationId: string
  key: string | null
  viewer: SettingsViewerSnapshot
}

type MessagesAcknowledgement = {
  hasMore: boolean
  messages: Message[]
  otherUser: OtherUser
}

type SendAcknowledgement = {
  message: Message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readServerError(value: unknown): { error?: string; error_code?: string } {
  if (!isRecord(value)) return {}
  return {
    error: typeof value.error === 'string' ? value.error : undefined,
    error_code: typeof value.error_code === 'string' ? value.error_code : undefined,
  }
}

function readOtherUser(value: unknown, viewerId: string): OtherUser | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id === viewerId ||
    !(value.handle === null || value.handle === undefined || typeof value.handle === 'string') ||
    !(
      value.avatar_url === null ||
      value.avatar_url === undefined ||
      typeof value.avatar_url === 'string'
    ) ||
    !(value.bio === null || value.bio === undefined || typeof value.bio === 'string')
  ) {
    return null
  }
  return value as OtherUser
}

function readMessage(value: unknown, viewerId: string, otherUserId: string): Message | null {
  if (!isRecord(value)) return null
  const participantPairIsExact =
    (value.sender_id === viewerId && value.receiver_id === otherUserId) ||
    (value.sender_id === otherUserId && value.receiver_id === viewerId)
  const mediaTypeIsValid =
    value.media_type === null ||
    value.media_type === undefined ||
    value.media_type === 'image' ||
    value.media_type === 'video' ||
    value.media_type === 'file'
  const createdAt = typeof value.created_at === 'string' ? Date.parse(value.created_at) : NaN
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    !participantPairIsExact ||
    typeof value.content !== 'string' ||
    typeof value.read !== 'boolean' ||
    !Number.isFinite(createdAt) ||
    !mediaTypeIsValid
  ) {
    return null
  }
  if (
    value.reactions !== undefined &&
    (!Array.isArray(value.reactions) ||
      value.reactions.some(
        (reaction) =>
          !isRecord(reaction) ||
          typeof reaction.emoji !== 'string' ||
          typeof reaction.count !== 'number' ||
          !Number.isInteger(reaction.count) ||
          reaction.count < 0 ||
          typeof reaction.mine !== 'boolean'
      ))
  ) {
    return null
  }
  return value as Message
}

function readMessagesAcknowledgement(
  value: unknown,
  viewerId: string,
  expectedOtherUserId?: string
): MessagesAcknowledgement | null {
  if (!isRecord(value) || !Array.isArray(value.messages) || typeof value.has_more !== 'boolean') {
    return null
  }
  const otherUser = readOtherUser(value.otherUser, viewerId)
  if (!otherUser || (expectedOtherUserId && otherUser.id !== expectedOtherUserId)) return null
  const messages: Message[] = []
  for (const candidate of value.messages) {
    const message = readMessage(candidate, viewerId, otherUser.id)
    if (!message) return null
    messages.push(message)
  }
  return { hasMore: value.has_more, messages, otherUser }
}

function readSendAcknowledgement(
  value: unknown,
  expected: {
    attachment?: MediaAttachment | null
    content: string
    conversationId: string
    receiverId: string
    viewerId: string
  }
): SendAcknowledgement | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.conversation_id !== expected.conversationId
  ) {
    return null
  }
  const message = readMessage(value.message, expected.viewerId, expected.receiverId)
  if (
    !message ||
    message.sender_id !== expected.viewerId ||
    message.receiver_id !== expected.receiverId ||
    message.content !== expected.content.trim() ||
    (expected.attachment &&
      (message.media_url !== expected.attachment.url ||
        message.media_type !== expected.attachment.type))
  ) {
    return null
  }
  return { message }
}

function readReactionAcknowledgement(
  value: unknown,
  expectedEmoji: string
): MessageReaction[] | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null
  const data = value.data
  if (
    (data.action !== 'added' && data.action !== 'removed') ||
    data.emoji !== expectedEmoji ||
    !isRecord(data.counts) ||
    !Array.isArray(data.userEmojis) ||
    data.userEmojis.some((emoji) => typeof emoji !== 'string')
  ) {
    return null
  }
  const userEmojis = new Set(data.userEmojis as string[])
  if (
    (data.action === 'added' && !userEmojis.has(expectedEmoji)) ||
    (data.action === 'removed' && userEmojis.has(expectedEmoji))
  ) {
    return null
  }
  const reactions: MessageReaction[] = []
  for (const [emoji, count] of Object.entries(data.counts)) {
    if (
      !DM_REACTION_EMOJIS.includes(emoji) ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      return null
    }
    if (count > 0) reactions.push({ emoji, count, mine: userEmojis.has(emoji) })
  }
  return reactions
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
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const optionsRef = useRef({ accessToken, conversationId, userId })
  optionsRef.current = { accessToken, conversationId, userId }
  const loginHref = buildConversationLoginHref(conversationId)
  const [messages, setMessages] = useState<Message[]>([])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
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
  const operationsRef = useRef(new Set<ConversationOperation>())
  const latestOperationByKeyRef = useRef(new Map<string, ConversationOperation>())
  // Maps reaction row id -> {messageId, emoji, userId} so DELETE events (which only
  // carry the PK under default replica identity) can be resolved back to a message.
  const reactionRowMapRef = useRef<
    Map<string, { messageId: string; emoji: string; userId: string }>
  >(new Map())

  useEffect(() => {
    const operations = operationsRef.current
    const latestOperations = latestOperationByKeyRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const operation of operations) operation.controller.abort()
      operations.clear()
      latestOperations.clear()
    }
  }, [])

  const beginOperation = useCallback(
    (
      key: string | null = null,
      expected?: { conversationId: string; userId: string }
    ): ConversationOperation | null => {
      const current = optionsRef.current
      const viewer = captureSettingsViewer(authRef.current)
      if (
        !mountedRef.current ||
        !current.conversationId ||
        !viewer ||
        viewer.userId !== current.userId ||
        viewer.accessToken !== current.accessToken ||
        (expected &&
          (expected.userId !== current.userId ||
            expected.conversationId !== current.conversationId)) ||
        !isSettingsViewerCurrent(viewer, authRef.current)
      ) {
        return null
      }
      if (key) {
        const previous = latestOperationByKeyRef.current.get(key)
        if (previous) {
          previous.controller.abort()
          operationsRef.current.delete(previous)
        }
      }
      const operation: ConversationOperation = {
        controller: new AbortController(),
        conversationId: current.conversationId,
        key,
        viewer,
      }
      operationsRef.current.add(operation)
      if (key) latestOperationByKeyRef.current.set(key, operation)
      return operation
    },
    []
  )

  const operationIsCurrent = useCallback((operation: ConversationOperation): boolean => {
    const current = optionsRef.current
    return (
      mountedRef.current &&
      operationsRef.current.has(operation) &&
      (!operation.key || latestOperationByKeyRef.current.get(operation.key) === operation) &&
      current.conversationId === operation.conversationId &&
      current.userId === operation.viewer.userId &&
      isSettingsViewerCurrent(operation.viewer, authRef.current)
    )
  }, [])

  const finishOperation = useCallback((operation: ConversationOperation) => {
    operationsRef.current.delete(operation)
    if (operation.key && latestOperationByKeyRef.current.get(operation.key) === operation) {
      latestOperationByKeyRef.current.delete(operation.key)
    }
  }, [])

  useEffect(() => {
    for (const operation of operationsRef.current) operation.controller.abort()
    operationsRef.current.clear()
    latestOperationByKeyRef.current.clear()
    setMessages([])
    setOtherUser(null)
    setLoading(Boolean(userId))
    setLoadingMore(false)
    setHasMore(true)
    setReplyingTo(null)
    reactionRowMapRef.current.clear()
    isLoadingOlderRef.current = false
    prevMessageCountRef.current = 0
  }, [auth.sessionGeneration, auth.viewerKey, conversationId, userId])

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

  const loadMessages = useCallback(async () => {
    const operation = beginOperation('messages')
    if (!operation) {
      if (authRef.current.authChecked && !authRef.current.userId) setLoading(false)
      return
    }
    try {
      setLoading(true)
      const result = await authedFetch<unknown>(
        `/api/messages?conversationId=${encodeURIComponent(operation.conversationId)}`,
        'GET',
        operation.viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (result.stale || !operationIsCurrent(operation)) return
      if (result.status === 401) {
        showToast(t('loginExpiredPleaseRelogin'), 'error')
        router.push(loginHref)
        return
      }
      if (!result.ok) {
        // 404/403 = the conversation doesn't exist or isn't ours (bad/stale link):
        // show a specific "gone" message instead of a generic failure, then send
        // the user back to their inbox rather than silently bouncing (U10-9).
        const isGone = result.status === 404 || result.status === 403
        const serverError = readServerError(result.data)
        showToast(
          isGone ? t('u10inbox_conversationGone') : serverError.error || t('loadMessagesFailed'),
          'error'
        )
        router.push('/inbox?tab=messages&chat=direct')
        return
      }
      const acknowledgement = readMessagesAcknowledgement(result.data, operation.viewer.userId)
      if (!acknowledgement) {
        showToast(t('loadMessagesFailed'), 'error')
        return
      }
      setMessages(acknowledgement.messages)
      setOtherUser(acknowledgement.otherUser)
      setHasMore(acknowledgement.hasMore)
    } catch {
      if (!operationIsCurrent(operation)) return
      showToast(t('networkErrorLoadMessages'), 'error')
    } finally {
      const isCurrent = operationIsCurrent(operation)
      if (isCurrent) setLoading(false)
      finishOperation(operation)
    }
  }, [beginOperation, finishOperation, loginHref, operationIsCurrent, router, showToast, t])

  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || latestOperationByKeyRef.current.has('messages')) return
    const counterpart = otherUser
    const oldest = messagesRef.current.find((message) => !message._tempId)
    if (!counterpart || !oldest) return
    const operation = userId ? beginOperation('messages', { conversationId, userId }) : null
    if (!operation) return
    setLoadingMore(true)
    try {
      const result = await authedFetch<unknown>(
        `/api/messages?conversationId=${encodeURIComponent(operation.conversationId)}&before=${encodeURIComponent(oldest.created_at)}`,
        'GET',
        operation.viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (result.stale || !operationIsCurrent(operation)) return
      const acknowledgement = result.ok
        ? readMessagesAcknowledgement(result.data, operation.viewer.userId, counterpart.id)
        : null
      if (!acknowledgement) {
        showToast(t('loadOlderMessagesFailed'), 'error')
        return
      }
      if (acknowledgement.messages.length) {
        isLoadingOlderRef.current = true
        setMessages((previous) => {
          const existingIds = new Set(previous.map((message) => message.id))
          return [
            ...acknowledgement.messages.filter((message) => !existingIds.has(message.id)),
            ...previous,
          ]
        })
        setHasMore(acknowledgement.hasMore)
      } else {
        setHasMore(false)
      }
    } catch {
      if (!operationIsCurrent(operation)) return
      showToast(t('loadOlderMessagesFailed'), 'error')
    } finally {
      const isCurrent = operationIsCurrent(operation)
      if (isCurrent) setLoadingMore(false)
      finishOperation(operation)
    }
  }, [
    beginOperation,
    conversationId,
    finishOperation,
    hasMore,
    loadingMore,
    operationIsCurrent,
    otherUser,
    showToast,
    t,
    userId,
  ])

  const markRead = useCallback(async () => {
    const operation = beginOperation('read')
    if (!operation) return
    try {
      const result = await authedFetch<unknown>(
        '/api/messages/read',
        'POST',
        operation.viewer.accessToken,
        { conversationId: operation.conversationId },
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
      if (result.stale || !operationIsCurrent(operation)) return
      const acknowledgement = result.data
      if (
        !result.ok ||
        !isRecord(acknowledgement) ||
        acknowledgement.ok !== true ||
        typeof acknowledgement.marked_count !== 'number' ||
        !Number.isInteger(acknowledgement.marked_count) ||
        acknowledgement.marked_count < 0 ||
        typeof acknowledgement.read_at !== 'string' ||
        !Number.isFinite(Date.parse(acknowledgement.read_at))
      ) {
        console.warn('[useConversationMessages] mark-read acknowledgement rejected')
      }
    } catch (error) {
      if (operationIsCurrent(operation)) {
        console.warn('[useConversationMessages] mark-read failed', error)
      }
    } finally {
      finishOperation(operation)
    }
  }, [beginOperation, finishOperation, operationIsCurrent])

  // Realtime: incoming messages
  useRealtime<Message>({
    table: 'direct_messages',
    event: 'INSERT',
    filter: otherUser ? `sender_id=eq.${otherUser.id}` : undefined,
    enabled: !!userId && !!conversationId && !!otherUser,
    autoReconnect: true,
    maxRetries: 10,
    onInsert: (newMsg) => {
      if (
        !mountedRef.current ||
        optionsRef.current.conversationId !== conversationId ||
        !userId ||
        !otherUser
      ) {
        return
      }
      const validatedMessage = readMessage(newMsg, userId, otherUser.id)
      if (
        validatedMessage &&
        validatedMessage.sender_id === otherUser.id &&
        validatedMessage.receiver_id === userId
      ) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === validatedMessage.id)) return prev
          return [...prev, validatedMessage]
        })
        void markRead()
      }
    },
    onStatusChange: (status) => {
      if (!mountedRef.current || optionsRef.current.conversationId !== conversationId) return
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
      if (
        mountedRef.current &&
        optionsRef.current.conversationId === conversationId &&
        updatedMsg.sender_id === userId &&
        updatedMsg.receiver_id === otherUser?.id &&
        updatedMsg.read
      ) {
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
      if (!mountedRef.current || optionsRef.current.conversationId !== conversationId) return
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
      if (!mountedRef.current || optionsRef.current.conversationId !== conversationId) return
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
  const sendMessageRequest = useCallback(
    async (
      operation: ConversationOperation,
      receiverId: string,
      content: string,
      attachment?: MediaAttachment | null,
      replyToId?: string | null
    ) => {
      const body: Record<string, unknown> = { receiverId, content }
      if (attachment) {
        body.media_url = attachment.url
        body.media_type = attachment.type
        body.media_name = attachment.originalName
      }
      if (replyToId) body.reply_to_id = replyToId
      return authedFetch<unknown>(
        '/api/messages',
        'POST',
        operation.viewer.accessToken,
        body,
        15_000,
        {
          expectedUserId: operation.viewer.userId,
          expectedSessionGeneration: operation.viewer.sessionGeneration,
          signal: operation.controller.signal,
        }
      )
    },
    []
  )

  const handleSend = useCallback(
    async (content: string, pendingAttachment: MediaAttachment | null): Promise<void> => {
      if (!userId || !otherUser) return
      if (content.length > 2000) {
        showToast(t('messageTooLong'), 'warning')
        return
      }
      const receiverId = otherUser.id
      const operation = beginOperation(null, { conversationId, userId })
      if (!operation || operation.viewer.userId !== userId) return
      const messageContent =
        content || (pendingAttachment ? `[${getMediaTypeLabel(pendingAttachment.type, t)}]` : '')

      // Snapshot + clear the reply target so the composer resets immediately
      const replyTo = replyingTo
      setReplyingTo(null)

      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticMessage: Message = {
        id: tempId,
        sender_id: operation.viewer.userId,
        receiver_id: receiverId,
        content: messageContent,
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
        const result = await sendMessageRequest(
          operation,
          receiverId,
          optimisticMessage.content,
          pendingAttachment,
          replyTo?.id
        )
        if (result.stale || !operationIsCurrent(operation)) return
        if (!result.ok) {
          const serverError = readServerError(result.data)
          const ec = resolveErrorCode(result.status, serverError)
          const em = getErrorMessage(ec, serverError.error)
          setMessages((prev) => updateMessageStatus(prev, tempId, true, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        const acknowledgement = readSendAcknowledgement(result.data, {
          attachment: pendingAttachment,
          content: optimisticMessage.content,
          conversationId: operation.conversationId,
          receiverId,
          viewerId: operation.viewer.userId,
        })
        if (!acknowledgement) {
          const ec = MessageErrorCode.SERVER_ERROR
          const em = getErrorMessage(ec)
          setMessages((prev) => updateMessageStatus(prev, tempId, true, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        setMessages((prev) =>
          prev.map((message) =>
            message._tempId === tempId
              ? {
                  ...acknowledgement.message,
                  reply_preview: optimisticMessage.reply_preview,
                  _status: 'sent' as MessageStatus,
                }
              : message
          )
        )
      } catch {
        if (!operationIsCurrent(operation)) return
        const ec = MessageErrorCode.NETWORK_ERROR
        const em = getErrorMessage(ec)
        setMessages((prev) => updateMessageStatus(prev, tempId, true, 'failed', ec, em))
        showToast(em, 'error')
      } finally {
        finishOperation(operation)
      }
    },
    [
      beginOperation,
      conversationId,
      finishOperation,
      operationIsCurrent,
      otherUser,
      replyingTo,
      sendMessageRequest,
      showToast,
      t,
      userId,
    ]
  )

  const handleRetry = useCallback(
    async (failedMsg: Message) => {
      if (
        !userId ||
        !otherUser ||
        failedMsg.sender_id !== userId ||
        failedMsg.receiver_id !== otherUser.id
      ) {
        return
      }
      const receiverId = otherUser.id
      const operation = beginOperation(`retry:${failedMsg.id}`, { conversationId, userId })
      if (!operation || operation.viewer.userId !== userId) return
      setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'sending'))
      try {
        const result = await sendMessageRequest(
          operation,
          receiverId,
          failedMsg.content,
          failedMsg._attachment,
          failedMsg.reply_to_id
        )
        if (result.stale || !operationIsCurrent(operation)) return
        if (!result.ok) {
          const serverError = readServerError(result.data)
          const ec = resolveErrorCode(result.status, serverError)
          const em = getErrorMessage(ec, serverError.error)
          setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        const acknowledgement = readSendAcknowledgement(result.data, {
          attachment: failedMsg._attachment,
          content: failedMsg.content,
          conversationId: operation.conversationId,
          receiverId,
          viewerId: operation.viewer.userId,
        })
        if (!acknowledgement) {
          const ec = MessageErrorCode.SERVER_ERROR
          const em = getErrorMessage(ec)
          setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em))
          showToast(em, 'error')
          return
        }
        setMessages((prev) =>
          prev.map((message) =>
            message.id === failedMsg.id
              ? { ...acknowledgement.message, _status: 'sent' as MessageStatus }
              : message
          )
        )
      } catch {
        if (!operationIsCurrent(operation)) return
        const ec = MessageErrorCode.NETWORK_ERROR
        const em = getErrorMessage(ec)
        setMessages((prev) => updateMessageStatus(prev, failedMsg.id, false, 'failed', ec, em))
        showToast(em, 'error')
      } finally {
        finishOperation(operation)
      }
    },
    [
      beginOperation,
      conversationId,
      finishOperation,
      operationIsCurrent,
      otherUser,
      sendMessageRequest,
      showToast,
      userId,
    ]
  )

  const handleVoiceSent = useCallback(
    async (attachment: MediaAttachment, duration: number) => {
      if (!userId || !otherUser || !attachment.url) return
      const receiverId = otherUser.id
      const operation = beginOperation(null, { conversationId, userId })
      if (!operation || operation.viewer.userId !== userId) return
      const content = `[Voice] ${t('voiceMessage')} (${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, '0')})`
      const tempId = `voice-${Date.now()}`
      const tempMsg: Message = {
        id: tempId,
        sender_id: operation.viewer.userId,
        receiver_id: receiverId,
        content,
        read: false,
        created_at: new Date().toISOString(),
        media_url: attachment.url,
        media_type: attachment.type,
        media_name: attachment.originalName,
        _status: 'sending',
        _tempId: tempId,
        _attachment: attachment,
      }
      setMessages((prev) => [...prev, tempMsg])
      try {
        const result = await sendMessageRequest(operation, receiverId, content, attachment)
        if (result.stale || !operationIsCurrent(operation)) return
        const acknowledgement = result.ok
          ? readSendAcknowledgement(result.data, {
              attachment,
              content,
              conversationId: operation.conversationId,
              receiverId,
              viewerId: operation.viewer.userId,
            })
          : null
        if (acknowledgement) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === tempId
                ? { ...acknowledgement.message, _status: 'sent' as MessageStatus }
                : message
            )
          )
        } else {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m))
          )
        }
      } catch {
        if (!operationIsCurrent(operation)) return
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, _status: 'failed' as MessageStatus } : m))
        )
      } finally {
        finishOperation(operation)
      }
    },
    [
      beginOperation,
      conversationId,
      finishOperation,
      operationIsCurrent,
      otherUser,
      sendMessageRequest,
      t,
      userId,
    ]
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
      const target = messagesRef.current.find((message) => message.id === msgId)
      if (!target || !userId || target.sender_id !== userId) return
      const operation = beginOperation(`delete:${msgId}`, { conversationId, userId })
      if (!operation || operation.viewer.userId !== userId) return
      setMessages((previous) => previous.filter((message) => message.id !== msgId))
      try {
        const result = await authedFetch<unknown>(
          `/api/messages/${encodeURIComponent(msgId)}`,
          'DELETE',
          operation.viewer.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (result.stale || !operationIsCurrent(operation)) return
        if (!result.ok || !isRecord(result.data) || result.data.success !== true) {
          setMessages((previous) =>
            previous.some((message) => message.id === target.id)
              ? previous
              : [...previous, target].sort(
                  (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)
                )
          )
          showToast(t('operationFailed'), 'error')
        }
      } catch {
        if (!operationIsCurrent(operation)) return
        setMessages((previous) =>
          previous.some((message) => message.id === target.id)
            ? previous
            : [...previous, target].sort(
                (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)
              )
        )
        showToast(t('operationFailed'), 'error')
      } finally {
        finishOperation(operation)
      }
    },
    [beginOperation, conversationId, finishOperation, operationIsCurrent, showToast, t, userId]
  )

  // Toggle an emoji reaction on a message — delta-based optimistic update + rollback.
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId || !DM_REACTION_EMOJIS.includes(emoji)) return
      const target = messagesRef.current.find((message) => message.id === messageId)
      if (
        !target ||
        !otherUser ||
        !(
          (target.sender_id === userId && target.receiver_id === otherUser.id) ||
          (target.sender_id === otherUser.id && target.receiver_id === userId)
        )
      ) {
        return
      }
      const operation = beginOperation(`reaction:${messageId}`, { conversationId, userId })
      if (!operation || operation.viewer.userId !== userId) return

      const wasMine = !!target.reactions?.find((reaction) => reaction.emoji === emoji)?.mine
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          return {
            ...m,
            reactions: applyReactionDelta(m.reactions, emoji, wasMine ? -1 : 1, !wasMine),
          }
        })
      )

      try {
        const result = await authedFetch<unknown>(
          `/api/messages/${encodeURIComponent(messageId)}/react`,
          'POST',
          operation.viewer.accessToken,
          { emoji },
          15_000,
          {
            expectedUserId: operation.viewer.userId,
            expectedSessionGeneration: operation.viewer.sessionGeneration,
            signal: operation.controller.signal,
          }
        )
        if (result.stale || !operationIsCurrent(operation)) return
        const reactions = result.ok ? readReactionAcknowledgement(result.data, emoji) : null
        if (reactions) {
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
      } finally {
        finishOperation(operation)
      }
    },
    [
      beginOperation,
      conversationId,
      finishOperation,
      operationIsCurrent,
      otherUser,
      showToast,
      t,
      userId,
    ]
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
    markRead,
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
