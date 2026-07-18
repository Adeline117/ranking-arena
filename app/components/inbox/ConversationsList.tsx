'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import Link from 'next/link'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import Avatar from '@/app/components/ui/Avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import dynamic from 'next/dynamic'

// Lazy load: modal only opens on user action
const CreateGroupModal = dynamic(() => import('@/app/components/features/CreateGroupModal'), {
  ssr: false,
})
import { getCsrfHeaders } from '@/lib/api/client'
import { Skeleton, SkeletonAvatar } from '@/app/components/ui/Skeleton'
import ErrorMessage from '@/app/components/ui/ErrorMessage'

type GroupChannel = {
  id: string
  name: string
  type: string
  avatar_url: string | null
  last_message_at: string
  last_message_preview: string | null
}

type Conversation = {
  id: string
  other_user: {
    id: string
    handle: string | null
    avatar_url?: string | null
  }
  last_message_at: string
  last_message_preview?: string
  unread_count: number
}

function calculateTotalUnread(conversations: Conversation[]): number {
  return conversations.reduce((sum, c) => sum + c.unread_count, 0)
}

function readCollection<T>(payload: unknown, key: string): T[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as Record<string, unknown>)[key])
  ) {
    throw new Error(`Invalid ${key} response`)
  }
  return (payload as Record<string, unknown>)[key] as T[]
}

function ConversationListSkeleton({
  label,
  rows = 2,
}: {
  label: string
  rows?: number
}): React.ReactElement {
  return (
    <div
      role="status"
      aria-label={label}
      style={{
        padding: tokens.spacing[3],
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[1],
      }}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          }}
        >
          <SkeletonAvatar size={40} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="40%" height="14px" />
              <Skeleton width="40px" height="10px" />
            </div>
            <Skeleton width="65%" height="12px" />
          </div>
        </div>
      ))}
    </div>
  )
}

function UnreadBadge({ count }: { count: number }): React.ReactElement | null {
  if (count <= 0) return null

  return (
    <span
      style={{
        minWidth: 18,
        height: 18,
        borderRadius: tokens.radius.md,
        background: tokens.colors.accent.primary,
        color: tokens.colors.white,
        fontSize: 12,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 4px',
        flexShrink: 0,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

/**
 * Swipeable conversation row with left-swipe to reveal delete action.
 * Uses raw touch events for smooth swipe-to-delete UX.
 */
function SwipeableConversationRow({
  children,
  onDelete,
  deleteLabel,
}: {
  children: React.ReactNode
  onDelete: () => void
  deleteLabel: string
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const isTracking = useRef(false)
  const [swipeX, setSwipeX] = useState(0)
  const [isAnimating, setIsAnimating] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const DELETE_THRESHOLD = 80
  const MAX_SWIPE = 100

  useEffect(() => {
    const el = rowRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent) => {
      startX.current = e.touches[0].clientX
      isTracking.current = true
      setIsAnimating(false)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!isTracking.current) return
      const deltaX = e.touches[0].clientX - startX.current
      if (deltaX < 0) {
        const damped = Math.max(deltaX * 0.8, -MAX_SWIPE)
        setSwipeX(damped)
      }
    }
    const onTouchEnd = () => {
      if (!isTracking.current) return
      isTracking.current = false
      setIsAnimating(true)

      if (Math.abs(swipeX) >= DELETE_THRESHOLD) {
        setShowConfirm(true)
      }
      setSwipeX(0)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)

    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [swipeX])

  return (
    <div style={{ position: 'relative', overflow: 'hidden' }}>
      {/* Red delete backdrop */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: MAX_SWIPE,
          background: tokens.colors.accent.error,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.white,
          fontSize: 12,
          fontWeight: 700,
          opacity: Math.min(Math.abs(swipeX) / DELETE_THRESHOLD, 1),
        }}
      >
        {deleteLabel}
      </div>

      {/* Slideable content */}
      <div
        ref={rowRef}
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: isAnimating ? 'transform 0.2s ease' : 'none',
          position: 'relative',
          zIndex: 1,
          background: tokens.colors.bg.primary,
        }}
      >
        {children}
      </div>

      {/* Delete confirmation overlay */}
      {showConfirm && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            zIndex: 2,
          }}
        >
          <button
            onClick={() => {
              setShowConfirm(false)
              onDelete()
            }}
            style={{
              padding: '6px 16px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: tokens.colors.accent.error,
              color: tokens.colors.white,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {deleteLabel}
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            style={{
              padding: '6px 16px',
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

type ChatFilter = 'all' | 'direct' | 'group'

export default function ConversationsList({
  initialFilter = 'all',
}: {
  initialFilter?: ChatFilter
} = {}): React.ReactElement | null {
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [chatFilter, setChatFilter] = useState<ChatFilter>(initialFilter)
  const setUnreadMessages = useInboxStore((s) => s.setUnreadMessages)
  const { language, t } = useLanguage()
  const {
    user,
    accessToken,
    getAuthHeadersAsync,
    isLoggedIn,
    loading: authLoading,
    authChecked,
    viewerKey,
  } = useAuthSession()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const authPending = authLoading || !authChecked
  const canLoad = !authPending && isLoggedIn && Boolean(accessToken)
  const conversationQueryKey = useMemo(
    () => ['inbox-conversations', viewerKey] as const,
    [viewerKey]
  )
  const groupChannelQueryKey = useMemo(
    () => ['inbox-group-channels', viewerKey] as const,
    [viewerKey]
  )

  useEffect(() => setChatFilter(initialFilter), [initialFilter])

  const {
    data: conversations = [],
    isError: conversationsFailed,
    isFetching: conversationsFetching,
    isSuccess: conversationsLoaded,
    refetch: refetchConversations,
  } = useQuery({
    queryKey: conversationQueryKey,
    queryFn: async () => {
      const headers = await getAuthHeadersAsync()
      const response = await fetch('/api/conversations', { headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return readCollection<Conversation>(await response.json(), 'conversations')
    },
    enabled: canLoad,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })

  const {
    data: groupChannels = [],
    isError: groupChannelsFailed,
    isFetching: groupChannelsFetching,
    isSuccess: groupChannelsLoaded,
    refetch: refetchGroupChannels,
  } = useQuery({
    queryKey: groupChannelQueryKey,
    queryFn: async () => {
      const headers = await getAuthHeadersAsync()
      const response = await fetch('/api/channels?type=group', { headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return readCollection<GroupChannel>(await response.json(), 'channels')
    },
    enabled: canLoad,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (conversationsLoaded) {
      setUnreadMessages(calculateTotalUnread(conversations))
    }
  }, [conversations, conversationsLoaded, setUnreadMessages])

  // Swipe-to-delete: clear conversation history and hide from list
  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      if (!accessToken) return
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch(`/api/chat/${conversationId}/settings`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', ...getCsrfHeaders() },
          body: JSON.stringify({ cleared_before: new Date().toISOString() }),
        })
        if (res.ok) {
          // Remove from local list immediately
          queryClient.setQueryData<Conversation[]>(conversationQueryKey, (current = []) => {
            const updated = current.filter((c) => c.id !== conversationId)
            setUnreadMessages(calculateTotalUnread(updated))
            return updated
          })
          showToast(t('conversationDeleted'), 'success')
        } else {
          showToast(t('unexpectedError'), 'error')
        }
      } catch {
        showToast(t('unexpectedError'), 'error')
      }
    },
    [
      accessToken,
      conversationQueryKey,
      getAuthHeadersAsync,
      queryClient,
      setUnreadMessages,
      showToast,
      t,
    ]
  )

  const loadConversations = useCallback(() => {
    void refetchConversations()
  }, [refetchConversations])

  const loadGroupChannels = useCallback(() => {
    void refetchGroupChannels()
  }, [refetchGroupChannels])

  // Realtime: auto-refresh when new DMs arrive for this user
  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel(`inbox:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${user.id}`,
        },
        (payload) => {
          // Incremental update: update the affected conversation in-place
          const newMsg = payload.new as {
            conversation_id?: string
            content?: string
            created_at?: string
            sender_id?: string
          }
          if (!newMsg.conversation_id) {
            loadConversations()
            return
          }
          let needsRefresh = false
          queryClient.setQueryData<Conversation[]>(conversationQueryKey, (current = []) => {
            const idx = current.findIndex((c) => c.id === newMsg.conversation_id)
            if (idx === -1) {
              needsRefresh = true
              return current
            }
            const updated = [...current]
            updated[idx] = {
              ...updated[idx],
              last_message_at: newMsg.created_at || new Date().toISOString(),
              last_message_preview: newMsg.content || '',
              unread_count: updated[idx].unread_count + 1,
            }
            // Re-sort by last_message_at descending
            updated.sort(
              (a, b) =>
                new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
            )
            setUnreadMessages(calculateTotalUnread(updated))
            return updated
          })
          if (needsRefresh) loadConversations()
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [conversationQueryKey, loadConversations, queryClient, setUnreadMessages, user?.id])

  // Realtime: auto-refresh when new group channel messages arrive
  useEffect(() => {
    if (!user?.id || groupChannels.length === 0) return
    const channel = supabase
      .channel(`group-inbox:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'channel_messages',
        },
        (payload) => {
          const newMsg = payload.new as {
            channel_id?: string
            content?: string
            created_at?: string
            sender_id?: string
          }
          // Skip messages sent by ourselves
          if (newMsg.sender_id === user.id) return
          // Update the affected group channel in-place
          if (!newMsg.channel_id) {
            loadGroupChannels()
            return
          }
          let needsRefresh = false
          queryClient.setQueryData<GroupChannel[]>(groupChannelQueryKey, (current = []) => {
            const idx = current.findIndex((ch) => ch.id === newMsg.channel_id)
            if (idx === -1) {
              needsRefresh = true
              return current
            }
            const updated = [...current]
            updated[idx] = {
              ...updated[idx],
              last_message_at: newMsg.created_at || new Date().toISOString(),
              last_message_preview: newMsg.content || '',
            }
            updated.sort(
              (a, b) =>
                new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
            )
            return updated
          })
          if (needsRefresh) loadGroupChannels()
        }
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [groupChannelQueryKey, groupChannels.length, loadGroupChannels, queryClient, user?.id])

  function formatTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const locale = getLocaleFromLanguage(language)

    if (days === 0) {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    }
    if (days === 1) {
      return t('yesterday')
    }
    if (days < 7) {
      return t('daysAgo').replace('{days}', String(days))
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  }

  const showDirect = chatFilter === 'all' || chatFilter === 'direct'
  const showGroups = chatFilter === 'all' || chatFilter === 'group'
  const directLoading = showDirect && conversationsFetching && conversations.length === 0
  const groupsLoading = showGroups && groupChannelsFetching && groupChannels.length === 0
  const visibleFailure = (showDirect && conversationsFailed) || (showGroups && groupChannelsFailed)
  const visibleData =
    (showDirect && conversations.length > 0) || (showGroups && groupChannels.length > 0)
  const visibleQueriesLoaded =
    (!showDirect || conversationsLoaded) && (!showGroups || groupChannelsLoaded)
  const showGenuineEmpty =
    canLoad &&
    visibleQueriesLoaded &&
    !visibleFailure &&
    !directLoading &&
    !groupsLoading &&
    !visibleData

  if (!authPending && !canLoad) return null

  return (
    <div>
      {/* Header with filter tabs + create group button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'direct', 'group'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setChatFilter(f)}
              style={{
                padding: '4px 10px',
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: chatFilter === f ? tokens.colors.accent.brand : 'transparent',
                color: chatFilter === f ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                minHeight: 28,
              }}
            >
              {f === 'all'
                ? t('allChats')
                : f === 'direct'
                  ? t('directMessages')
                  : t('groupMessages')}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowCreateGroup(true)}
          style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            border: 'none',
            background: tokens.colors.bg.tertiary,
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          title={t('createGroupChat')}
          aria-label={t('createGroupChat')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} />

      {authPending ? (
        <ConversationListSkeleton label={t('loading')} rows={4} />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {showGroups && groupChannelsFailed && (
            <div style={{ padding: tokens.spacing[4] }}>
              <ErrorMessage
                title={t('groupMessages')}
                message={t('failedToLoadRetryShort')}
                onRetry={loadGroupChannels}
              />
            </div>
          )}
          {groupsLoading && (
            <ConversationListSkeleton label={`${t('groupMessages')}: ${t('loading')}`} />
          )}
          {/* Group channels */}
          {showGroups &&
            groupChannels.map((ch) => (
              <Link
                key={`ch-${ch.id}`}
                href={`/channels/${ch.id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div
                  className="hover-bg-secondary"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: `linear-gradient(135deg, ${tokens.colors.accent.brand}44, ${tokens.colors.accent.brand}22)`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={tokens.colors.accent.brand}
                      strokeWidth="1.5"
                    >
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 2,
                      }}
                    >
                      <span
                        style={{ fontWeight: 600, fontSize: 13, color: tokens.colors.text.primary }}
                      >
                        {ch.name}
                      </span>
                      <span
                        style={{ fontSize: 11, color: tokens.colors.text.tertiary, flexShrink: 0 }}
                      >
                        {formatTime(ch.last_message_at)}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        color: tokens.colors.text.tertiary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block',
                      }}
                    >
                      {ch.last_message_preview || t('groupChat')}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          {showDirect && conversationsFailed && (
            <div style={{ padding: tokens.spacing[4] }}>
              <ErrorMessage
                title={t('directMessages')}
                message={t('failedToLoadRetryShort')}
                onRetry={loadConversations}
              />
            </div>
          )}
          {directLoading && (
            <ConversationListSkeleton label={`${t('directMessages')}: ${t('loading')}`} />
          )}
          {/* Direct conversations — swipe left to reveal delete */}
          {showDirect &&
            conversations.map((conv) => (
              <SwipeableConversationRow
                key={conv.id}
                onDelete={() => handleDeleteConversation(conv.id)}
                deleteLabel={t('delete')}
              >
                <Link
                  href={`/messages/${conv.id}`}
                  style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      background:
                        conv.unread_count > 0 ? 'var(--color-notification-unread)' : 'transparent',
                      transition: 'background 0.15s',
                      cursor: 'pointer',
                    }}
                    className="hover-bg-secondary"
                  >
                    <div style={{ flexShrink: 0 }}>
                      <Avatar
                        userId={conv.other_user.id}
                        name={conv.other_user.handle || 'User'}
                        avatarUrl={conv.other_user.avatar_url}
                        size={40}
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: 2,
                        }}
                      >
                        <span
                          style={{
                            fontWeight: conv.unread_count > 0 ? 800 : 600,
                            fontSize: 13,
                            color: tokens.colors.text.primary,
                          }}
                        >
                          {conv.other_user.handle || `User ${conv.other_user.id.slice(0, 8)}`}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: tokens.colors.text.tertiary,
                            flexShrink: 0,
                          }}
                        >
                          {formatTime(conv.last_message_at)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            fontSize: 12,
                            color:
                              conv.unread_count > 0
                                ? tokens.colors.text.primary
                                : tokens.colors.text.tertiary,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                          }}
                        >
                          {conv.last_message_preview || t('startChat')}
                        </span>
                        <UnreadBadge count={conv.unread_count} />
                      </div>
                    </div>
                  </div>
                </Link>
              </SwipeableConversationRow>
            ))}
          {showGenuineEmpty && (
            <div
              style={{
                padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[3],
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background:
                    'linear-gradient(135deg, var(--color-accent-primary-15) 0%, var(--color-accent-primary-08) 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.colors.accent.brand}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 14,
                    color: tokens.colors.text.primary,
                    marginBottom: 4,
                  }}
                >
                  {t('noMessages')}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: tokens.colors.text.tertiary,
                    lineHeight: 1.5,
                    maxWidth: 240,
                    margin: '0 auto',
                  }}
                >
                  {t('u10inbox_dmEmptyCta')}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
