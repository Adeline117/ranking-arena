'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { formatTimeAgo } from '@/lib/utils/date'
import { selectScopedUnreadNotifications, useInboxStore } from '@/lib/stores/inboxStore'
import { authedFetch } from '@/lib/api/client'
import { type NotificationWithActor } from '@/lib/types'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import { PERSISTED_NOTIFICATION_TYPES } from '@/lib/types/notification'
import {
  captureInboxViewer,
  inboxViewerScopeKey,
  isInboxViewerCurrent,
} from '@/lib/inbox/viewer-scope'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

type Notification = NotificationWithActor
type NotificationFilter = 'all' | 'follow' | 'like' | 'comment' | 'mention'
type NotificationCursor = { before: string; beforeId: string }
type NotificationPage = {
  notifications: Notification[]
  nextCursor: NotificationCursor | null
  unreadCount: number
}

const PAGE_SIZE = 20
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NOTIFICATION_TYPE_SET = new Set<string>(PERSISTED_NOTIFICATION_TYPES)
const NOTIFICATION_KEYS = [
  'actor_avatar_url',
  'actor_handle',
  'actor_id',
  'created_at',
  'id',
  'link',
  'message',
  'read',
  'reference_id',
  'title',
  'type',
  'user_id',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function timestampMicros(value: string): number | null {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  if (fraction.length > 6) return null
  return milliseconds * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6))
}

function comparePosition(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string }
): number | null {
  const leftTime = timestampMicros(left.created_at)
  const rightTime = timestampMicros(right.created_at)
  if (leftTime === null || rightTime === null) return null
  if (leftTime !== rightTime) return leftTime - rightTime
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function isSafeNotificationLink(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function readNotification(value: unknown, viewerId: string): Notification | null {
  if (!isRecord(value) || !hasExactKeys(value, NOTIFICATION_KEYS)) return null
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    value.user_id !== viewerId ||
    typeof value.type !== 'string' ||
    !NOTIFICATION_TYPE_SET.has(value.type) ||
    typeof value.title !== 'string' ||
    typeof value.message !== 'string' ||
    !(
      value.link === null ||
      (typeof value.link === 'string' && isSafeNotificationLink(value.link))
    ) ||
    typeof value.read !== 'boolean' ||
    !(
      value.actor_id === null ||
      (typeof value.actor_id === 'string' && UUID_PATTERN.test(value.actor_id))
    ) ||
    !(value.reference_id === null || typeof value.reference_id === 'string') ||
    typeof value.created_at !== 'string' ||
    timestampMicros(value.created_at) === null ||
    !(value.actor_handle === null || typeof value.actor_handle === 'string') ||
    !(value.actor_avatar_url === null || typeof value.actor_avatar_url === 'string') ||
    (value.actor_id === null && (value.actor_handle !== null || value.actor_avatar_url !== null))
  ) {
    return null
  }

  return {
    id: value.id,
    user_id: viewerId,
    type: value.type as Notification['type'],
    title: value.title,
    message: value.message,
    link: value.link,
    read: value.read,
    actor_id: value.actor_id,
    reference_id: value.reference_id,
    created_at: value.created_at,
    actor_handle: value.actor_handle ?? undefined,
    actor_avatar_url: value.actor_avatar_url,
  }
}

function readNotificationPage(
  value: unknown,
  viewerId: string,
  requestCursor: NotificationCursor | null
): NotificationPage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['notifications', 'next_cursor', 'unread_count']) ||
    !Array.isArray(value.notifications) ||
    value.notifications.length > PAGE_SIZE ||
    typeof value.unread_count !== 'number' ||
    !Number.isSafeInteger(value.unread_count) ||
    value.unread_count < 0
  ) {
    return null
  }

  let nextCursor: NotificationCursor | null = null
  if (value.next_cursor !== null) {
    if (
      !isRecord(value.next_cursor) ||
      !hasExactKeys(value.next_cursor, ['before', 'before_id']) ||
      typeof value.next_cursor.before !== 'string' ||
      timestampMicros(value.next_cursor.before) === null ||
      typeof value.next_cursor.before_id !== 'string' ||
      !UUID_PATTERN.test(value.next_cursor.before_id)
    ) {
      return null
    }
    nextCursor = {
      before: value.next_cursor.before,
      beforeId: value.next_cursor.before_id,
    }
  }

  if (nextCursor !== null && value.notifications.length !== PAGE_SIZE) return null

  const notifications: Notification[] = []
  const notificationIds = new Set<string>()
  for (const candidate of value.notifications) {
    const notification = readNotification(candidate, viewerId)
    if (!notification || notificationIds.has(notification.id)) return null
    notificationIds.add(notification.id)

    const previous = notifications.at(-1)
    if (previous) {
      const order = comparePosition(previous, notification)
      if (order === null || order <= 0) return null
    }
    if (requestCursor) {
      const cursorOrder = comparePosition(notification, {
        id: requestCursor.beforeId,
        created_at: requestCursor.before,
      })
      if (cursorOrder === null || cursorOrder >= 0) return null
    }
    notifications.push(notification)
  }

  if (nextCursor !== null) {
    const last = notifications.at(-1)
    if (!last || nextCursor.before !== last.created_at || nextCursor.beforeId !== last.id) {
      return null
    }
  }

  return {
    notifications,
    nextCursor,
    unreadCount: value.unread_count,
  }
}

// U10-4: notification title/message are stored as English in the DB. Localize at
// render time by type so zh/ja/ko users don't see mixed-language cards. The
// message body for like/comment/reply/mention is user content (post title /
// comment text) — leave it untouched; only the generated sentences are localized.
function localizeNotifTitle(notif: Notification, t: (key: string) => string): string {
  const handle = notif.actor_handle || ''
  switch (notif.type) {
    case 'new_follower':
    case 'follow':
      return t('notifText_new_follower_title')
    case 'like':
      return handle ? t('notifText_like').replace('{handle}', handle) : notif.title
    case 'comment':
      return handle ? t('notifText_comment').replace('{handle}', handle) : notif.title
    case 'post_reply':
      return handle ? t('notifText_post_reply').replace('{handle}', handle) : notif.title
    case 'mention':
      return handle ? t('notifText_mention').replace('{handle}', handle) : notif.title
    default:
      return notif.title // trader_alert / system etc — dynamic content, keep stored
  }
}

function localizeNotifMessage(notif: Notification, t: (key: string) => string): string {
  if (notif.type === 'new_follower' || notif.type === 'follow') {
    const handle = notif.actor_handle
    return handle
      ? t('notifText_new_follower_msg').replace('{handle}', handle)
      : t('notifText_new_follower_msg_generic')
  }
  return notif.message // user content — keep as-is
}

// variant='panel' (default): dropdown/bell panel form — collapsible section header
// + capped inner scroll. variant='page': dedicated /inbox page — the page already
// has its own H1 + tab, so the inner collapsible "通知 N" header is redundant and
// double-names the section (U10-6). Page mode renders the list directly (no chevron,
// no collapse, no inner scroll cap) and keeps only the mark-all action.
export default function NotificationsList({
  variant = 'panel',
}: { variant?: 'panel' | 'page' } = {}) {
  const isPanel = variant !== 'page'
  const [typeFilter, setTypeFilter] = useState<NotificationFilter>('all')
  const [collapsed, setCollapsed] = useState(false)
  const effectiveCollapsed = isPanel ? collapsed : false
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const viewer = useMemo(() => captureInboxViewer(auth), [auth])
  const scopeKey = viewer
    ? inboxViewerScopeKey(viewer)
    : `invalid:${auth.viewerKey}\u0000${auth.sessionGeneration}`
  const activateViewer = useInboxStore((state) => state.activateViewer)
  const setUnreadNotifications = useInboxStore((s) => s.setUnreadNotifications)
  const unreadNotifications = useInboxStore((state) =>
    viewer ? selectScopedUnreadNotifications(state, viewer) : 0
  )
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  const queryClient = useQueryClient()
  // 用于防止重复请求和回滚
  const pendingMarkAllRef = useRef<string | null>(null)
  const pendingMarkRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (viewer) activateViewer(viewer)
  }, [activateViewer, scopeKey, viewer])

  // React Query infinite scroll for notifications
  const {
    data: notifData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage: loadingMore,
    isLoading: loading,
    isError: loadFailed,
    refetch: refetchNotifications,
  } = useInfiniteQuery({
    queryKey: [
      'notifications',
      viewer?.viewerKey ?? 'inactive',
      viewer?.sessionGeneration ?? -1,
      typeFilter,
    ],
    queryFn: async ({ pageParam }) => {
      if (!viewer || !isInboxViewerCurrent(viewer, authRef.current)) {
        throw new Error('stale inbox viewer')
      }
      const cursor = pageParam as NotificationCursor | null
      const parameters = new URLSearchParams({
        filter: typeFilter,
        limit: String(PAGE_SIZE),
      })
      if (cursor) {
        parameters.set('cursor', cursor.before)
        parameters.set('cursorId', cursor.beforeId)
      }
      const result = await authedFetch<unknown>(
        `/api/notifications?${parameters.toString()}`,
        'GET',
        viewer.accessToken,
        undefined,
        15_000,
        {
          expectedUserId: viewer.userId,
          expectedSessionGeneration: viewer.sessionGeneration,
        }
      )
      if (!result.ok || result.stale || !isInboxViewerCurrent(viewer, authRef.current)) {
        throw new Error(`HTTP ${result.status}`)
      }
      const page = readNotificationPage(result.data, viewer.userId, cursor)
      if (!page) throw new Error('Invalid notifications response')
      return page
    },
    initialPageParam: null as NotificationCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(viewer),
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })

  const fetchedNotifications = useMemo(
    () => notifData?.pages.flatMap((p) => p.notifications) ?? [],
    [notifData]
  )
  // Local state for optimistic mark-as-read mutations
  const [notifications, setNotifications] = useViewerOwnedState<Notification[]>(
    [],
    () => [],
    `${scopeKey}\u0000${typeFilter}`
  )
  useEffect(() => {
    setNotifications(fetchedNotifications)
  }, [fetchedNotifications, scopeKey, setNotifications, typeFilter])
  const hasMore = hasNextPage ?? false

  // Sync unread count from first page
  useEffect(() => {
    if (viewer && notifData?.pages[0] && isInboxViewerCurrent(viewer, authRef.current)) {
      setUnreadNotifications(viewer, notifData.pages[0].unreadCount)
    }
  }, [notifData, scopeKey, setUnreadNotifications, viewer])

  const loadNotifications = useCallback(() => {
    refetchNotifications()
  }, [refetchNotifications])
  const loadMoreNotifications = useCallback(() => {
    if (hasMore && !loadingMore) fetchNextPage()
  }, [hasMore, loadingMore, fetchNextPage])

  // useInfiniteQuery handles abort/cleanup internally — no manual effect needed

  const markAllAsRead = useCallback(async () => {
    if (!viewer || !isInboxViewerCurrent(viewer, authRef.current)) return
    const operation = viewer
    const operationScopeKey = inboxViewerScopeKey(operation)
    if (pendingMarkAllRef.current === operationScopeKey) return
    pendingMarkAllRef.current = operationScopeKey

    // Delta: capture IDs that were unread (not a full snapshot — just the delta set)
    const unreadIds = new Set(notifications.filter((n) => !n.read).map((n) => n.id))
    const previousUnreadCount = unreadNotifications

    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadNotifications(operation, 0)

    try {
      const result = await authedFetch(
        '/api/notifications',
        'PUT',
        operation.accessToken,
        { mark_all: true },
        15_000,
        {
          expectedUserId: operation.userId,
          expectedSessionGeneration: operation.sessionGeneration,
        }
      )
      if (result.stale || !isInboxViewerCurrent(operation, authRef.current)) return
      if (!result.ok) {
        throw new Error(`Failed to mark all as read: ${result.status}`)
      }
      await queryClient.invalidateQueries({
        queryKey: ['notifications', operation.viewerKey, operation.sessionGeneration],
        refetchType: 'none',
      })
    } catch {
      if (!isInboxViewerCurrent(operation, authRef.current)) return
      // Delta rollback: only restore read=false for IDs that were unread before
      setNotifications((prev) => prev.map((n) => (unreadIds.has(n.id) ? { ...n, read: false } : n)))
      setUnreadNotifications(operation, previousUnreadCount)
      showToast(t('operationFailed'), 'error')
    } finally {
      if (pendingMarkAllRef.current === operationScopeKey) pendingMarkAllRef.current = null
    }
  }, [
    notifications,
    queryClient,
    setNotifications,
    setUnreadNotifications,
    showToast,
    t,
    unreadNotifications,
    viewer,
  ])

  const markAsRead = useCallback(
    async (id: string) => {
      if (!viewer || !isInboxViewerCurrent(viewer, authRef.current)) return
      const operation = viewer
      const pendingKey = `${inboxViewerScopeKey(operation)}\u0000${id}`
      if (pendingMarkRef.current.has(pendingKey)) return
      pendingMarkRef.current.add(pendingKey)

      // 找到当前通知的状态
      const currentNotification = notifications.find((n) => n.id === id)
      if (!currentNotification || currentNotification.read) {
        pendingMarkRef.current.delete(pendingKey)
        return
      }

      // Optimistic update (delta-based)
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
      const currentUnreadCount = selectScopedUnreadNotifications(
        useInboxStore.getState(),
        operation
      )
      setUnreadNotifications(operation, Math.max(0, currentUnreadCount - 1))

      try {
        const result = await authedFetch(
          '/api/notifications',
          'PUT',
          operation.accessToken,
          { notification_id: id },
          15_000,
          {
            expectedUserId: operation.userId,
            expectedSessionGeneration: operation.sessionGeneration,
          }
        )
        if (result.stale || !isInboxViewerCurrent(operation, authRef.current)) return
        if (!result.ok) {
          throw new Error(`Failed to mark as read: ${result.status}`)
        }
        await queryClient.invalidateQueries({
          queryKey: ['notifications', operation.viewerKey, operation.sessionGeneration],
          refetchType: 'none',
        })
      } catch {
        if (!isInboxViewerCurrent(operation, authRef.current)) return
        // Delta rollback: reverse the -1 from current state
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: false } : n)))
        const currentCount = selectScopedUnreadNotifications(useInboxStore.getState(), operation)
        setUnreadNotifications(operation, currentCount + 1)
        showToast(t('operationFailed'), 'error')
      } finally {
        pendingMarkRef.current.delete(pendingKey)
      }
    },
    [notifications, queryClient, setNotifications, setUnreadNotifications, showToast, t, viewer]
  )

  function getIcon(type: string): string {
    switch (type) {
      case 'follow':
      case 'new_follower':
        return t('notifIconFollow')
      case 'like':
        return t('notifIconLike')
      case 'comment':
      case 'post_reply':
        return t('notifIconComment')
      case 'mention':
        return t('notifIconMention')
      default:
        return t('notifIconDefault')
    }
  }

  return (
    <div style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
      {/* Page variant: no collapsible section header (page already has H1 + tab).
          Keep only a right-aligned "mark all as read" action. */}
      {!isPanel && unreadNotifications > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]} 0`,
          }}
        >
          <button
            onClick={markAllAsRead}
            style={{
              padding: '4px 8px',
              border: 'none',
              background: 'transparent',
              color: tokens.colors.accent.primary,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('markAllAsRead')}
          </button>
        </div>
      )}
      {/* Section header (panel variant only) */}
      {isPanel && (
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s',
                color: tokens.colors.text.tertiary,
              }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span
              style={{
                fontWeight: 700,
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.text.primary,
              }}
            >
              {t('notifications')}
            </span>
            {unreadNotifications > 0 && (
              <span
                style={{
                  padding: '1px 6px',
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.accent.primary,
                  color: tokens.colors.white,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {unreadNotifications}
              </span>
            )}
          </div>
          {unreadNotifications > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                markAllAsRead()
              }}
              style={{
                padding: '4px 8px',
                border: 'none',
                background: 'transparent',
                color: tokens.colors.accent.primary,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('markAllAsRead')}
            </button>
          )}
        </div>
      )}

      {/* Filter tabs */}
      {!effectiveCollapsed && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: `0 ${tokens.spacing[4]} ${tokens.spacing[2]}`,
            overflowX: 'auto',
          }}
        >
          {(['all', 'follow', 'like', 'comment', 'mention'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              style={{
                padding: '3px 10px',
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: typeFilter === f ? tokens.colors.accent.brand : 'transparent',
                color: typeFilter === f ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                minHeight: 24,
              }}
            >
              {f === 'all' ? t('all') : t(`notifType_${f}`) || f}
            </button>
          ))}
        </div>
      )}

      {/* Notifications list */}
      {!effectiveCollapsed && (
        <div style={isPanel ? { maxHeight: 'min(400px, 60vh)', overflowY: 'auto' } : undefined}>
          {!loading && loadFailed && (
            <div style={{ padding: tokens.spacing[4] }}>
              <ErrorMessage
                message={t('failedToLoadRetryShort')}
                onRetry={() => void loadNotifications()}
              />
            </div>
          )}
          {loading ? (
            <div
              style={{
                padding: tokens.spacing[3],
                display: 'flex',
                flexDirection: 'column',
                gap: tokens.spacing[2],
              }}
            >
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: tokens.colors.bg.tertiary,
                      flexShrink: 0,
                      animation: 'shimmer 1.5s ease-in-out infinite',
                      backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`,
                      backgroundSize: '200% 100%',
                    }}
                  />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div
                      style={{
                        width: '70%',
                        height: 14,
                        borderRadius: 4,
                        background: tokens.colors.bg.tertiary,
                        animation: 'shimmer 1.5s ease-in-out infinite',
                        backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`,
                        backgroundSize: '200% 100%',
                      }}
                    />
                    <div
                      style={{
                        width: '50%',
                        height: 12,
                        borderRadius: 4,
                        background: tokens.colors.bg.tertiary,
                        animation: 'shimmer 1.5s ease-in-out infinite',
                        backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`,
                        backgroundSize: '200% 100%',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : loadFailed && notifications.length === 0 ? null : notifications.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center' }}>
              <Image
                src="/stickers/gn.webp"
                alt="No notifications"
                width={48}
                height={48}
                unoptimized
                style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }}
              />
              <p style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                {typeFilter === 'all' ? t('noNotifications') : t('noNotificationsForFilter')}
              </p>
            </div>
          ) : (
            notifications.map((notif) => {
              const content = (
                <div
                  key={notif.id}
                  onClick={() => {
                    if (!notif.read) markAsRead(notif.id)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    background: notif.read ? 'transparent' : 'var(--color-notification-unread)',
                    transition: 'background 0.15s',
                    cursor: notif.link ? 'pointer' : 'default',
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      background: tokens.colors.bg.secondary,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 14,
                      flexShrink: 0,
                      overflow: 'hidden',
                    }}
                  >
                    {notif.actor_avatar_url ? (
                      <Image
                        src={avatarSrc(notif.actor_avatar_url)}
                        alt={`${notif.actor_handle || 'User'} avatar`}
                        width={32}
                        height={32}
                        sizes="32px"
                        loading="lazy"
                        unoptimized
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    ) : (
                      getIcon(notif.type)
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: tokens.colors.text.primary,
                        marginBottom: 2,
                      }}
                    >
                      {localizeNotifTitle(notif, t)}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: tokens.colors.text.secondary,
                        marginBottom: 2,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {localizeNotifMessage(notif, t)}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                      {formatTimeAgo(notif.created_at, language)}
                    </div>
                  </div>
                  {!notif.read && (
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: tokens.colors.accent.primary,
                        flexShrink: 0,
                        marginTop: 6,
                      }}
                    />
                  )}
                </div>
              )

              return notif.link ? (
                <Link
                  key={notif.id}
                  href={notif.link}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  {content}
                </Link>
              ) : (
                <div key={notif.id}>{content}</div>
              )
            })
          )}
          {!loading && hasMore && notifications.length > 0 && (
            <div
              style={{ textAlign: 'center', padding: `${tokens.spacing[3]} ${tokens.spacing[4]}` }}
            >
              <button
                onClick={loadMoreNotifications}
                disabled={loadingMore}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: loadingMore ? 'not-allowed' : 'pointer',
                  opacity: loadingMore ? 0.6 : 1,
                }}
              >
                {loadingMore ? t('loading') : t('loadMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
