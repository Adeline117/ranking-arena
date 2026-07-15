'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { useRealtime } from '@/lib/hooks/useRealtime'
import { usePresence, formatLastSeen } from '@/lib/hooks/usePresence'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  applyReactionDelta,
  DM_REACTION_EMOJIS,
} from '@/app/(app)/messages/[conversationId]/components/types'
import type {
  MessageReaction,
  ReplyPreview,
} from '@/app/(app)/messages/[conversationId]/components/types'

type ChannelMessage = {
  id: string
  channel_id: string
  sender_id: string
  content: string
  media_url?: string | null
  media_type?: 'image' | 'video' | 'file' | null
  media_name?: string | null
  created_at: string
  reply_to_id?: string | null
  reply_preview?: ReplyPreview | null
  reactions?: MessageReaction[]
  _status?: 'sending' | 'sent' | 'failed'
  _tempId?: string
}

type Member = {
  user_id: string
  role: string
  nickname: string | null
  handle: string | null
  avatar_url: string | null
  joined_at: string
}

type Channel = {
  id: string
  name: string
  type: string
  avatar_url: string | null
  description: string | null
  created_by: string
}

export default function ChannelPage({ params }: { params: Promise<{ channelId: string }> }) {
  const router = useRouter()
  const { showToast } = useToast()
  const { t } = useLanguage()
  const { email, accessToken, userId, authChecked } = useAuthSession()
  const [channelId, setChannelId] = useState('')
  const [channel, setChannel] = useState<Channel | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [myRole, setMyRole] = useState('')
  const [loading, setLoading] = useState(true)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pendingAttachment, setPendingAttachment] = useState<{
    url: string
    type: 'image' | 'video' | 'file'
    originalName: string
    fileSize?: number
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  // Reply / quote: the message currently being replied to (null = not replying)
  const [replyingTo, setReplyingTo] = useState<ChannelMessage | null>(null)
  // Per-message context menu (react / reply / copy)
  const [ctxMenu, setCtxMenu] = useState<{ msgId: string; x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard against state updates after unmount in realtime callbacks (CLAUDE.md)
  const mountedRef = useRef(true)
  // Maps reaction row id -> {messageId, emoji, userId} so DELETE events (PK-only
  // under default replica identity) resolve back to a message.
  const reactionRowMapRef = useRef<
    Map<string, { messageId: string; emoji: string; userId: string }>
  >(new Map())

  const memberIds = members.map((m) => m.user_id)
  const { getUserPresence } = usePresence(userId || null, memberIds)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return
    const handleClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [ctxMenu])

  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      ;(params as Promise<{ channelId: string }>)
        .then((r) => setChannelId(r.channelId))
        .catch(() => {
          /* params resolution should not fail */
        })
    }
  }, [params])

  const loadChannel = useCallback(async () => {
    if (!channelId || !accessToken) return
    setLoading(true)
    try {
      const res = await globalThis.fetch(`/api/channels/${channelId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      if (!res.ok) {
        // Localize instead of surfacing the raw API string (was leaking English
        // "Not a member" onto a zh page). 403 = not a member, 404 = gone.
        const msg =
          res.status === 403
            ? t('channelNotMember')
            : res.status === 404
              ? t('channelNotFoundDesc')
              : t('loadFailed2')
        showToast(msg, 'error')
        router.push('/inbox?tab=messages&chat=group')
        return
      }
      setChannel(data.channel)
      setMembers(data.members || [])
      setMessages(data.messages || [])
      setMyRole(data.my_role)
      setHasMore(data.has_more)
    } catch {
      showToast(t('loadFailed2'), 'error')
    } finally {
      setLoading(false)
    }
  }, [channelId, accessToken, showToast, router]) // eslint-disable-line react-hooks/exhaustive-deps -- t is stable

  useEffect(() => {
    loadChannel()
  }, [loadChannel])

  // Anonymous users have no accessToken, so loadChannel early-returns and `loading`
  // would stay true forever (permanent "加载中..." death page). Once auth has been
  // checked and there is still no session, send them to login with a return URL.
  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push(`/login?returnUrl=/channels/${channelId || ''}`)
    }
  }, [authChecked, accessToken, channelId, router])

  // Mark channel read on open / refocus / new message so group unread state
  // advances (channel_message_reads.last_read_at). Table exists since 00065.
  useEffect(() => {
    if (!channelId || !accessToken) return
    const markRead = () => {
      globalThis
        .fetch(`/api/channels/${channelId}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        .catch(() => void 0)
    }
    markRead()
    const onVisible = () => {
      if (document.visibilityState === 'visible') markRead()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [channelId, accessToken, messages.length])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Realtime subscription for new channel messages
  useRealtime<ChannelMessage>({
    table: 'channel_messages',
    event: 'INSERT',
    filter: channelId ? `channel_id=eq.${channelId}` : undefined,
    enabled: !!channelId && !!userId,
    autoReconnect: true,
    maxRetries: 10,
    onInsert: (msg) => {
      if (msg.sender_id !== userId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev
          return [...prev, msg]
        })
      }
    },
  })

  // Realtime: emoji reactions (INSERT). RLS limits delivery to channel members;
  // we only apply when the affected message is already in view.
  useRealtime<{ id: string; message_id: string; user_id: string; emoji: string }>({
    table: 'channel_message_reactions',
    event: 'INSERT',
    enabled: !!channelId && !!userId,
    autoReconnect: true,
    maxRetries: 5,
    onInsert: (row) => {
      if (!mountedRef.current) return
      reactionRowMapRef.current.set(row.id, {
        messageId: row.message_id,
        emoji: row.emoji,
        userId: row.user_id,
      })
      // Our own reactions are already applied optimistically.
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

  // Realtime: emoji reactions (DELETE). Default replica identity sends only the PK,
  // so resolve message/emoji via the row map populated on INSERT.
  useRealtime<{ id: string }>({
    table: 'channel_message_reactions',
    event: 'DELETE',
    enabled: !!channelId && !!userId,
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

  // Toggle an emoji reaction — delta-based optimistic update + rollback.
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!userId || !accessToken || !channelId) return
      setCtxMenu(null)

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
        const res = await globalThis.fetch(
          `/api/channels/${channelId}/messages/${messageId}/react`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
              ...getCsrfHeaders(),
            },
            body: JSON.stringify({ emoji }),
          }
        )
        const data = await res.json()
        if (res.ok && data.success) {
          const counts = (data.counts || {}) as Record<string, number>
          const userEmojis = new Set((data.userEmojis || []) as string[])
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
    [userId, accessToken, channelId, showToast] // eslint-disable-line react-hooks/exhaustive-deps -- t is stable
  )

  const getMemberName = (senderId: string) => {
    const m = members.find((m) => m.user_id === senderId)
    return m?.nickname || m?.handle || senderId.slice(0, 8)
  }

  const getMemberAvatar = (senderId: string) => {
    const m = members.find((m) => m.user_id === senderId)
    return m?.avatar_url || null
  }

  const handleSend = async () => {
    const hasContent = newMessage.trim() || pendingAttachment
    if (!hasContent || !userId || !channelId || sending) return

    const content = newMessage.trim()
    if (content.length > 2000) {
      showToast(t('messageTooLong'), 'warning')
      return
    }

    // Snapshot + clear the reply target so the composer resets immediately
    const replyTo = replyingTo
    setReplyingTo(null)

    const tempId = `temp_${Date.now()}`
    const optimistic: ChannelMessage = {
      id: tempId,
      channel_id: channelId,
      sender_id: userId,
      content: content || (pendingAttachment ? `[${pendingAttachment.type}]` : ''),
      media_url: pendingAttachment?.url,
      media_type: pendingAttachment?.type,
      media_name: pendingAttachment?.originalName,
      created_at: new Date().toISOString(),
      reply_to_id: replyTo?.id ?? null,
      reply_preview: replyTo
        ? { sender_id: replyTo.sender_id, content: (replyTo.content || '').slice(0, 120) }
        : null,
      _status: 'sending',
      _tempId: tempId,
    }

    setMessages((prev) => [...prev, optimistic])
    setNewMessage('')
    const attachment = pendingAttachment
    setPendingAttachment(null)
    inputRef.current?.focus()
    setSending(true)

    try {
      const body: Record<string, unknown> = {
        content: content || `[${attachment?.type || 'file'}]`,
      }
      if (attachment) {
        body.media_url = attachment.url
        body.media_type = attachment.type
        body.media_name = attachment.originalName
      }
      if (replyTo) {
        body.reply_to_id = replyTo.id
      }
      const res = await globalThis.fetch(`/api/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok && data.message) {
        setMessages((prev) =>
          prev.map((m) =>
            m._tempId === tempId
              ? { ...data.message, reply_preview: optimistic.reply_preview, _status: 'sent' }
              : m
          )
        )
      } else {
        setMessages((prev) =>
          prev.map((m) => (m._tempId === tempId ? { ...m, _status: 'failed' } : m))
        )
        showToast(data.error || t('sendFailed'), 'error')
      }
    } catch {
      setMessages((prev) =>
        prev.map((m) => (m._tempId === tempId ? { ...m, _status: 'failed' } : m))
      )
    } finally {
      setSending(false)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !userId || !channelId) return
    if (fileInputRef.current) fileInputRef.current.value = ''
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)
      formData.append('conversationId', channelId)
      // /api/chat/upload is withAuth (Bearer header only) — 401'd without the token
      const res = await globalThis.fetch('/api/chat/upload', {
        method: 'POST',
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...getCsrfHeaders(),
        },
        body: formData,
      })
      const data = await res.json()
      if (res.ok) {
        setPendingAttachment({
          url: data.url,
          type: data.category,
          originalName: data.originalName,
          fileSize: data.fileSize,
        })
      } else {
        showToast(data.error || t('uploadFailed'), 'error')
      }
    } catch {
      showToast(t('uploadFailed'), 'error')
    } finally {
      setUploading(false)
    }
  }

  const loadOlder = async () => {
    if (!hasMore || loadingMore || !channelId || !accessToken) return
    const oldest = messages.find((m) => !m._tempId)
    if (!oldest) return
    setLoadingMore(true)
    try {
      const res = await globalThis.fetch(`/api/channels/${channelId}?before=${oldest.created_at}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      if (data.messages?.length) {
        setMessages((prev) => [...data.messages, ...prev])
        setHasMore(data.has_more)
      } else {
        setHasMore(false)
      }
    } catch {
      /* Pagination load failed — keep existing messages visible */
    } finally {
      setLoadingMore(false)
    }
  }

  const handleRemoveMember = async (targetId: string) => {
    if (!confirm(t('confirmRemoveMember'))) return
    try {
      const res = await globalThis.fetch(`/api/channels/${channelId}/members`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ userId: targetId }),
      })
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.user_id !== targetId))
        showToast(t('memberRemoved'), 'success')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    }
  }

  const handleLeave = async () => {
    if (!confirm(t('confirmLeaveGroup'))) return
    try {
      const res = await globalThis.fetch(`/api/channels/${channelId}/members`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ userId }),
      })
      if (res.ok) {
        showToast(t('leftGroup'), 'success')
        router.push('/inbox?tab=messages&chat=group')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    }
  }

  const handleToggleRole = async (targetId: string, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin'
    try {
      await globalThis.fetch(`/api/channels/${channelId}/members`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ userId: targetId, role: newRole }),
      })
      setMembers((prev) => prev.map((m) => (m.user_id === targetId ? { ...m, role: newRole } : m)))
    } catch {
      showToast(t('operationFailed'), 'error')
    }
  }

  const formatTime = (d: string) =>
    new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  if (!authChecked || loading) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  if (!channel) return null

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary} 50%, ${tokens.colors.bg.primary} 100%)`,
        color: tokens.colors.text.primary,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Link
          href="/inbox?tab=messages&chat=group"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary,
            textDecoration: 'none',
            color: tokens.colors.text.primary,
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </Link>

        <Box style={{ flex: 1 }}>
          <Text size="base" weight="bold">
            {channel.name}
          </Text>
          <Text size="xs" color="tertiary">
            {t('memberCount').replace('{n}', String(members.length))}
          </Text>
        </Box>

        <button
          onClick={() => setShowMembers(!showMembers)}
          style={{
            width: 44,
            height: 44,
            minWidth: 44,
            borderRadius: tokens.radius.full,
            border: 'none',
            background: showMembers ? tokens.colors.bg.hover : 'transparent',
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title={t('memberList')}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </button>
      </Box>

      <Box style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Messages area */}
        <Box
          style={{
            flex: 1,
            overflow: 'auto',
            padding: `${tokens.spacing[4]} ${tokens.spacing[4]} ${tokens.spacing[6]}`,
            maxWidth: 800,
            margin: '0 auto',
            width: '100%',
          }}
        >
          {hasMore && (
            <Box style={{ textAlign: 'center', marginBottom: 12 }}>
              <button
                onClick={loadOlder}
                disabled={loadingMore}
                style={{
                  padding: '6px 16px',
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.xl,
                  color: tokens.colors.text.secondary,
                  fontSize: 13,
                  cursor: loadingMore ? 'not-allowed' : 'pointer',
                }}
              >
                {loadingMore ? t('loading') : t('loadOlderMessages')}
              </button>
            </Box>
          )}

          {messages.map((msg, i) => {
            const isMine = msg.sender_id === userId
            const prev = i > 0 ? messages[i - 1] : null
            const showAvatar = !isMine && msg.sender_id !== prev?.sender_id
            const showName = !isMine && msg.sender_id !== prev?.sender_id

            const replySenderLabel = msg.reply_preview
              ? msg.reply_preview.sender_id === userId
                ? t('you')
                : getMemberName(msg.reply_preview.sender_id)
              : ''

            return (
              <Box
                key={msg.id}
                onContextMenu={(e) => {
                  if (msg._status === 'sending') return
                  e.preventDefault()
                  setCtxMenu({ msgId: msg.id, x: e.clientX, y: e.clientY })
                }}
                onTouchStart={() => {
                  if (msg._status === 'sending') return
                  longPressTimer.current = setTimeout(() => {
                    setCtxMenu({ msgId: msg.id, x: 0, y: 0 })
                  }, 500)
                }}
                onTouchEnd={() => {
                  if (longPressTimer.current) {
                    clearTimeout(longPressTimer.current)
                    longPressTimer.current = null
                  }
                }}
                onTouchCancel={() => {
                  if (longPressTimer.current) {
                    clearTimeout(longPressTimer.current)
                    longPressTimer.current = null
                  }
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: isMine ? 'flex-end' : 'flex-start',
                  marginBottom: msg.sender_id === messages[i + 1]?.sender_id ? 3 : 12,
                }}
              >
                {showName && (
                  <Text
                    size="xs"
                    weight="bold"
                    style={{
                      marginBottom: 2,
                      marginLeft: 36,
                      color: tokens.colors.accent.brand,
                    }}
                  >
                    {getMemberName(msg.sender_id)}
                  </Text>
                )}
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 8,
                    maxWidth: '80%',
                    flexDirection: isMine ? 'row-reverse' : 'row',
                  }}
                >
                  {!isMine && (
                    <Box style={{ width: 28, flexShrink: 0 }}>
                      {showAvatar && (
                        <Box style={{ position: 'relative' }}>
                          <Avatar
                            userId={msg.sender_id}
                            name={getMemberName(msg.sender_id)}
                            avatarUrl={getMemberAvatar(msg.sender_id)}
                            size={28}
                          />
                          {getUserPresence(msg.sender_id).isOnline && (
                            <Box
                              style={{
                                position: 'absolute',
                                bottom: -1,
                                right: -1,
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: tokens.colors.accent.success,
                                border: `1.5px solid ${tokens.colors.bg.secondary}`,
                              }}
                            />
                          )}
                        </Box>
                      )}
                    </Box>
                  )}
                  <Box
                    style={{
                      padding: '11px 16px',
                      borderRadius: 18,
                      background: isMine ? tokens.gradient.primary : tokens.colors.bg.secondary,
                      color: isMine ? 'var(--color-on-accent)' : tokens.colors.text.primary,
                      border: isMine ? 'none' : `1px solid ${tokens.colors.border.primary}`,
                      boxShadow: tokens.shadow.sm,
                      opacity: msg._status === 'sending' ? 0.6 : 1,
                      maxWidth: '75%',
                    }}
                  >
                    {/* Quoted reply preview */}
                    {msg.reply_preview && (
                      <Box
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          marginBottom: 6,
                          padding: '6px 10px',
                          borderRadius: tokens.radius.md,
                          borderLeft: `3px solid ${isMine ? 'var(--color-on-accent)' : tokens.colors.accent.brand}`,
                          background: isMine
                            ? 'var(--glass-border-heavy)'
                            : tokens.colors.bg.tertiary,
                          maxWidth: '100%',
                        }}
                      >
                        <Text
                          size="xs"
                          style={{ fontWeight: 700, opacity: 0.85, color: 'inherit' }}
                        >
                          {replySenderLabel}
                        </Text>
                        <Text
                          size="xs"
                          style={{
                            opacity: 0.7,
                            color: 'inherit',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: 240,
                          }}
                        >
                          {msg.reply_preview.content || t('file')}
                        </Text>
                      </Box>
                    )}
                    {msg.media_url && msg.media_type === 'image' && (
                      <Image
                        src={msg.media_url}
                        alt="Shared image"
                        width={300}
                        height={200}
                        sizes="(max-width: 768px) 100vw, 300px"
                        loading="lazy"
                        style={{
                          maxWidth: '100%',
                          borderRadius: tokens.radius.lg,
                          marginBottom: 4,
                        }}
                      />
                    )}
                    {msg.content && !msg.content.startsWith('[') && (
                      <Text
                        size="sm"
                        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
                      >
                        {msg.content}
                      </Text>
                    )}
                  </Box>
                </Box>
                {/* Emoji reaction pills */}
                {msg.reactions && msg.reactions.length > 0 && (
                  <Box
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                      marginTop: 4,
                      paddingLeft: isMine ? 0 : 36,
                      paddingRight: isMine ? 4 : 0,
                      justifyContent: isMine ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                    }}
                  >
                    {msg.reactions.map((r) => (
                      <button
                        key={r.emoji}
                        onClick={() => handleToggleReaction(msg.id, r.emoji)}
                        className="interactive-scale"
                        aria-label={`React ${r.emoji}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '2px 8px',
                          borderRadius: tokens.radius.full,
                          border: `1px solid ${r.mine ? 'var(--color-accent-primary-40)' : tokens.colors.border.primary}`,
                          background: r.mine
                            ? 'var(--color-accent-primary-12)'
                            : tokens.colors.bg.secondary,
                          cursor: 'pointer',
                          fontSize: 13,
                          lineHeight: 1.6,
                          transition: `all ${tokens.transition.fast}`,
                        }}
                      >
                        <span>{r.emoji}</span>
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: r.mine
                              ? tokens.colors.accent.primary
                              : tokens.colors.text.tertiary,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {r.count}
                        </span>
                      </button>
                    ))}
                  </Box>
                )}
                {msg.sender_id !== messages[i + 1]?.sender_id && msg._status !== 'failed' && (
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{
                      marginTop: 3,
                      opacity: 0.5,
                      fontSize: 11,
                      paddingLeft: isMine ? 0 : 36,
                    }}
                  >
                    {msg._status === 'sending' ? t('sending') : formatTime(msg.created_at)}
                  </Text>
                )}
                {msg._status === 'failed' && (
                  <Text
                    size="xs"
                    style={{ color: tokens.colors.accent.error, marginTop: 3, fontSize: 11 }}
                  >
                    {t('sendFailed')}
                  </Text>
                )}
              </Box>
            )
          })}

          {messages.length === 0 && (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Text size="base" weight="bold">
                {t('startConversation')}
              </Text>
            </Box>
          )}
          <div ref={messagesEndRef} />
        </Box>

        {/* Members sidebar */}
        {showMembers && (
          <Box
            style={{
              width: 260,
              borderLeft: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              overflow: 'auto',
              padding: tokens.spacing[4],
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: 12 }}>
              {t('memberList')} ({members.length})
            </Text>
            {members.map((m) => {
              const presence = getUserPresence(m.user_id)
              return (
                <Box
                  key={m.user_id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 4px',
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <Box style={{ position: 'relative' }}>
                    <Avatar
                      userId={m.user_id}
                      name={m.handle || m.user_id.slice(0, 8)}
                      avatarUrl={m.avatar_url}
                      size={32}
                    />
                    <Box
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: presence.isOnline
                          ? tokens.colors.accent.success
                          : tokens.colors.text.tertiary,
                        border: `1.5px solid ${tokens.colors.bg.secondary}`,
                      }}
                    />
                  </Box>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {m.nickname || m.handle || m.user_id.slice(0, 8)}
                    </Text>
                    <Text size="xs" color="tertiary">
                      {m.role === 'owner'
                        ? t('groupOwner')
                        : m.role === 'admin'
                          ? t('groupAdmin')
                          : presence.isOnline
                            ? t('onlineNow')
                            : formatLastSeen(presence.lastSeenAt, t)}
                    </Text>
                  </Box>
                  {/* Admin actions */}
                  {myRole === 'owner' && m.user_id !== userId && (
                    <Box style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => handleToggleRole(m.user_id, m.role)}
                        title={m.role === 'admin' ? t('removeAdmin') : t('setAsAdmin')}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          border: 'none',
                          background: 'transparent',
                          color: tokens.colors.text.tertiary,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleRemoveMember(m.user_id)}
                        title={t('removeMember')}
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          border: 'none',
                          background: 'transparent',
                          color: tokens.colors.accent.error,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </Box>
                  )}
                </Box>
              )
            })}
            {myRole !== 'owner' && (
              <button
                onClick={handleLeave}
                style={{
                  width: '100%',
                  padding: '10px',
                  marginTop: 16,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${alpha(tokens.colors.accent.error, 20)}`,
                  background: `${alpha(tokens.colors.accent.error, 7)}`,
                  color: tokens.colors.accent.error,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {t('leaveGroup')}
              </button>
            )}
          </Box>
        )}
      </Box>

      {/* Input area */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,.pdf,.doc,.docx,.txt,.zip"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      {/* Reply preview bar */}
      {replyingTo && (
        <Box
          style={{
            maxWidth: 800,
            margin: '0 auto',
            marginBottom: 4,
            padding: '8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.lg,
            borderLeft: `3px solid ${tokens.colors.accent.brand}`,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.accent.brand}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="xs" style={{ fontWeight: 700, color: tokens.colors.accent.brand }}>
              {t('replyingTo')}{' '}
              {replyingTo.sender_id === userId ? t('you') : getMemberName(replyingTo.sender_id)}
            </Text>
            <Text
              size="xs"
              color="tertiary"
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {replyingTo.content && !replyingTo.content.startsWith('[')
                ? replyingTo.content
                : t('file')}
            </Text>
          </Box>
          <button
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: 'none',
              background: 'var(--color-accent-error-15)',
              color: tokens.colors.accent.error,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </Box>
      )}

      {pendingAttachment && (
        <Box
          style={{
            maxWidth: 800,
            margin: '0 auto',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.lg,
          }}
        >
          <Text
            size="sm"
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {pendingAttachment.originalName}
          </Text>
          <button
            onClick={() => setPendingAttachment(null)}
            style={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              border: 'none',
              background: 'var(--color-accent-error-15)',
              color: tokens.colors.accent.error,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </Box>
      )}

      <Box
        style={{
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]} ${tokens.spacing[4]}`,
          background: tokens.colors.bg.secondary,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box
          style={{
            maxWidth: 800,
            margin: '0 auto',
            display: 'flex',
            gap: tokens.spacing[2],
            alignItems: 'flex-end',
            background: tokens.colors.bg.primary,
            borderRadius: 28,
            padding: '8px 8px 8px 14px',
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
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
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder={t('enterMessage')}
            rows={1}
            style={{
              flex: 1,
              padding: '8px 0',
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              outline: 'none',
              resize: 'none',
              minHeight: 24,
              maxHeight: 100,
              lineHeight: 1.5,
            }}
          />
          <button
            onClick={handleSend}
            aria-label="Send message"
            disabled={(!newMessage.trim() && !pendingAttachment) || sending}
            style={{
              width: 42,
              height: 42,
              borderRadius: '50%',
              border: 'none',
              background:
                newMessage.trim() || pendingAttachment
                  ? tokens.gradient.primary
                  : tokens.colors.bg.tertiary,
              color:
                newMessage.trim() || pendingAttachment
                  ? 'var(--color-on-accent)'
                  : tokens.colors.text.tertiary,
              cursor: (newMessage.trim() || pendingAttachment) && !sending ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </Box>
      </Box>

      {/* Message context menu — react / reply / copy */}
      {ctxMenu &&
        (() => {
          const ctxMsg = messages.find((m) => m.id === ctxMenu.msgId)
          if (!ctxMsg) return null
          return (
            <div
              ref={ctxMenuRef}
              style={{
                position: 'fixed',
                top: ctxMenu.y || '50%',
                left: ctxMenu.x || '50%',
                transform: ctxMenu.x ? 'none' : 'translate(-50%, -50%)',
                zIndex: tokens.zIndex.max,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.lg,
                boxShadow: tokens.shadow.xl,
                overflow: 'hidden',
                minWidth: 140,
              }}
            >
              {/* Quick emoji reactions */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 2,
                  padding: '8px 8px',
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  maxWidth: 240,
                }}
              >
                {DM_REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => handleToggleReaction(ctxMsg.id, emoji)}
                    className="interactive-scale"
                    aria-label={`React ${emoji}`}
                    style={{
                      width: 32,
                      height: 32,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                      border: 'none',
                      borderRadius: tokens.radius.md,
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              {/* Reply */}
              <button
                onClick={() => {
                  setReplyingTo(ctxMsg)
                  setCtxMenu(null)
                  inputRef.current?.focus()
                }}
                aria-label="Reply"
                className="hover-bg-tertiary"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '10px 16px',
                  border: 'none',
                  background: 'transparent',
                  color: tokens.colors.text.primary,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 17 4 12 9 7" />
                  <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                </svg>
                {t('reply')}
              </button>
              {/* Copy text */}
              {ctxMsg.content && !ctxMsg.content.startsWith('[') && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(ctxMsg.content).catch(() => {
                      /* clipboard write may fail in some browsers */
                    })
                    setCtxMenu(null)
                  }}
                  aria-label="Copy text"
                  className="hover-bg-tertiary"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '10px 16px',
                    border: 'none',
                    background: 'transparent',
                    color: tokens.colors.text.primary,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {t('copyText')}
                </button>
              )}
            </div>
          )
        })()}
    </Box>
  )
}
