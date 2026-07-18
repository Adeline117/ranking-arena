'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { formatTimeAgo } from '@/lib/utils/date'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { getCsrfHeaders } from '@/lib/api/client'
import { type NotificationWithActor } from '@/lib/types'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import ErrorMessage from '@/app/components/ui/ErrorMessage'

type Notification = NotificationWithActor

// U10-2: chip filter → actual stored notification type(s). Producers emit
// `new_follower` (not `follow`) and `post_reply` (not `comment`), so the naive
// `n.type === chip` match left the Follows/Comments chips permanently empty.
const FILTER_TYPE_MAP: Record<string, string[]> = {
  follow: ['follow', 'new_follower'],
  like: ['like'],
  comment: ['comment', 'post_reply'],
  mention: ['mention'],
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
  const [typeFilter, setTypeFilter] = useState<'all' | 'follow' | 'like' | 'comment' | 'mention'>(
    'all'
  )
  const [collapsed, setCollapsed] = useState(false)
  const effectiveCollapsed = isPanel ? collapsed : false
  const PAGE_SIZE = 20
  const { accessToken } = useAuthSession()
  const setUnreadNotifications = useInboxStore((s) => s.setUnreadNotifications)
  const unreadNotifications = useInboxStore((s) => s.unreadNotifications)
  const queryClient = useQueryClient()
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  // 用于防止重复请求和回滚
  const pendingMarkAllRef = useRef(false)
  const pendingMarkRef = useRef<Set<string>>(new Set())

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
    queryKey: ['notifications', accessToken],
    queryFn: async ({ pageParam = 0 }: { pageParam: number }) => {
      const res = await fetch(`/api/notifications?offset=${pageParam}&limit=${PAGE_SIZE}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json()
      const data = result.data || result
      return {
        notifications: (data.notifications || []) as Notification[],
        unread_count: (data.unread_count as number) || 0,
        hasMore: (data.notifications || []).length >= PAGE_SIZE,
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined
      return allPages.reduce((sum, p) => sum + p.notifications.length, 0)
    },
    enabled: !!accessToken,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })

  const fetchedNotifications = useMemo(
    () => notifData?.pages.flatMap((p) => p.notifications) ?? [],
    [notifData]
  )
  // Local state for optimistic mark-as-read mutations
  const [notifications, setNotifications] = useState<Notification[]>([])
  useEffect(() => {
    setNotifications(fetchedNotifications)
  }, [fetchedNotifications])
  const hasMore = hasNextPage ?? false

  // U10-2/U10-3: filter by the chip using the type map, and drive the empty
  // state off the *filtered* result so an empty category shows a message
  // instead of a blank pane.
  const filtered = useMemo(
    () =>
      notifications.filter(
        (n) => typeFilter === 'all' || (FILTER_TYPE_MAP[typeFilter]?.includes(n.type) ?? false)
      ),
    [notifications, typeFilter]
  )

  // Sync unread count from first page
  useEffect(() => {
    if (notifData?.pages[0]) {
      setUnreadNotifications(notifData.pages[0].unread_count)
    }
  }, [notifData, setUnreadNotifications])

  const loadNotifications = useCallback(() => {
    refetchNotifications()
  }, [refetchNotifications])
  const loadMoreNotifications = useCallback(() => {
    if (hasMore && !loadingMore) fetchNextPage()
  }, [hasMore, loadingMore, fetchNextPage])

  // useInfiniteQuery handles abort/cleanup internally — no manual effect needed

  const markAllAsRead = useCallback(async () => {
    if (!accessToken || pendingMarkAllRef.current) return
    pendingMarkAllRef.current = true

    // Delta: capture IDs that were unread (not a full snapshot — just the delta set)
    const unreadIds = new Set(notifications.filter((n) => !n.read).map((n) => n.id))
    const unreadCount = unreadIds.size

    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadNotifications(0)

    try {
      const response = await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ mark_all: true }),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) {
        throw new Error('Failed to mark all as read')
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      // Delta rollback: only restore read=false for IDs that were unread before
      setNotifications((prev) => prev.map((n) => (unreadIds.has(n.id) ? { ...n, read: false } : n)))
      setUnreadNotifications(unreadCount)
      showToast(t('operationFailed'), 'error')
    } finally {
      pendingMarkAllRef.current = false
    }
  }, [accessToken, notifications, unreadNotifications, setUnreadNotifications, showToast, t])

  const markAsRead = useCallback(
    async (id: string) => {
      if (!accessToken || pendingMarkRef.current.has(id)) return
      pendingMarkRef.current.add(id)

      // 找到当前通知的状态
      const currentNotification = notifications.find((n) => n.id === id)
      if (!currentNotification || currentNotification.read) {
        pendingMarkRef.current.delete(id)
        return
      }

      // Optimistic update (delta-based)
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
      setUnreadNotifications(Math.max(0, unreadNotifications - 1))

      try {
        const response = await fetch('/api/notifications', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ notification_id: id }),
          signal: AbortSignal.timeout(15000),
        })
        if (!response.ok) {
          throw new Error('Failed to mark as read')
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return
        // Delta rollback: reverse the -1 from current state
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: false } : n)))
        setUnreadNotifications(useInboxStore.getState().unreadNotifications + 1)
        showToast(t('operationFailed'), 'error')
      } finally {
        pendingMarkRef.current.delete(id)
      }
    },
    [accessToken, notifications, unreadNotifications, setUnreadNotifications, showToast, t]
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
          ) : loadFailed && notifications.length === 0 ? null : filtered.length === 0 ? (
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
            filtered.map((notif) => {
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
