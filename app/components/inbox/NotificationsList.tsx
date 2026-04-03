'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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

type Notification = NotificationWithActor

export default function NotificationsList() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [typeFilter, setTypeFilter] = useState<'all' | 'follow' | 'like' | 'comment' | 'mention'>('all')
  const [collapsed, setCollapsed] = useState(false)
  const PAGE_SIZE = 20
  const { accessToken } = useAuthSession()
  const setUnreadNotifications = useInboxStore((s) => s.setUnreadNotifications)
  const unreadNotifications = useInboxStore((s) => s.unreadNotifications)
  const { showToast } = useToast()
  const { t, language } = useLanguage()
  // 用于防止重复请求和回滚
  const pendingMarkAllRef = useRef(false)
  const pendingMarkRef = useRef<Set<string>>(new Set())

  const loadNotifications = useCallback(async (abortSignal?: AbortSignal) => {
    if (!accessToken) return
    try {
      setLoading(true)
      const response = await fetch('/api/notifications', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: abortSignal
      })

      if (abortSignal?.aborted) return

      if (!response.ok) {
        const errorMessage = response.status === 401 ? t('authenticationFailed') : t('failedToLoadNotifications')
        showToast(errorMessage, 'error')
        return
      }

      const result = await response.json()
      const data = result.data || result
      const notifs = data.notifications || []
      setNotifications(notifs)
      setUnreadNotifications(data.unread_count || 0)
      setHasMore(notifs.length >= PAGE_SIZE)
    } catch (err) {
      if (abortSignal?.aborted) return

      logger.error('Failed to load notifications:', err)
      showToast(t('unexpectedError'), 'error')
    } finally {
      if (!abortSignal?.aborted) {
        setLoading(false)
      }
    }
  }, [accessToken, setUnreadNotifications, showToast, t])

  const loadMoreNotifications = useCallback(async () => {
    if (!accessToken || loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const response = await fetch(`/api/notifications?offset=${notifications.length}&limit=${PAGE_SIZE}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return
      const result = await response.json()
      const data = result.data || result
      const moreNotifs = data.notifications || []
      setNotifications(prev => [...prev, ...moreNotifs])
      setHasMore(moreNotifs.length >= PAGE_SIZE)
    } catch (err) {
      logger.error('Failed to load more notifications:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [accessToken, loadingMore, hasMore, notifications.length])

  useEffect(() => {
    const abortController = new AbortController()
    const timeoutId = setTimeout(() => abortController.abort(), 15000)

    if (accessToken) {
      loadNotifications(abortController.signal).finally(() => clearTimeout(timeoutId))
    } else {
      clearTimeout(timeoutId)
    }

    return () => {
      clearTimeout(timeoutId)
      abortController.abort()
    }
  }, [accessToken, loadNotifications])

  const markAllAsRead = useCallback(async () => {
    if (!accessToken || pendingMarkAllRef.current) return
    pendingMarkAllRef.current = true

    // 保存原状态用于回滚
    const prevNotifications = [...notifications]
    const prevUnreadCount = unreadNotifications

    // 乐观更新
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadNotifications(0)

    try {
      const response = await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
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
      // 回滚
      setNotifications(prevNotifications)
      setUnreadNotifications(prevUnreadCount)
      showToast(t('operationFailed'), 'error')
    } finally {
      pendingMarkAllRef.current = false
    }
  }, [accessToken, notifications, unreadNotifications, setUnreadNotifications, showToast, t])

  const markAsRead = useCallback(async (id: string) => {
    if (!accessToken || pendingMarkRef.current.has(id)) return
    pendingMarkRef.current.add(id)

    // 找到当前通知的状态
    const currentNotification = notifications.find(n => n.id === id)
    if (!currentNotification || currentNotification.read) {
      pendingMarkRef.current.delete(id)
      return
    }

    // 乐观更新
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n))
    setUnreadNotifications(Math.max(0, unreadNotifications - 1))

    try {
      const response = await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
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
      // 回滚
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: false } : n))
      setUnreadNotifications(unreadNotifications)
      showToast(t('operationFailed'), 'error')
    } finally {
      pendingMarkRef.current.delete(id)
    }
  }, [accessToken, notifications, unreadNotifications, setUnreadNotifications, showToast, t])

  function getIcon(type: string): string {
    switch (type) {
      case 'follow':
        return t('notifIconFollow')
      case 'like':
        return t('notifIconLike')
      case 'comment':
        return t('notifIconComment')
      case 'mention':
        return t('notifIconMention')
      default:
        return t('notifIconDefault')
    }
  }

  return (
    <div style={{ borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
      {/* Section header */}
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
          <span style={{ fontWeight: 700, fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.primary }}>
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

      {/* Filter tabs */}
      {!collapsed && (
        <div style={{
          display: 'flex', gap: 4,
          padding: `0 ${tokens.spacing[4]} ${tokens.spacing[2]}`,
          overflowX: 'auto',
        }}>
          {(['all', 'follow', 'like', 'comment', 'mention'] as const).map(f => (
            <button key={f} onClick={() => setTypeFilter(f)} style={{
              padding: '3px 10px', borderRadius: tokens.radius.lg, border: 'none',
              background: typeFilter === f ? tokens.colors.accent.brand : 'transparent',
              color: typeFilter === f ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              minHeight: 24,
            }}>
              {f === 'all' ? t('all') : t(`notifType_${f}`) || f}
            </button>
          ))}
        </div>
      )}

      {/* Notifications list */}
      {!collapsed && (
        <div style={{ maxHeight: 'min(400px, 60vh)', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: tokens.spacing[3], display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3], padding: `${tokens.spacing[3]} ${tokens.spacing[4]}` }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: tokens.colors.bg.tertiary, flexShrink: 0, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ width: '70%', height: 14, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                    <div style={{ width: '50%', height: 12, borderRadius: 4, background: tokens.colors.bg.tertiary, animation: 'shimmer 1.5s ease-in-out infinite', backgroundImage: `linear-gradient(90deg, ${tokens.colors.bg.tertiary} 0%, var(--glass-bg-light) 50%, ${tokens.colors.bg.tertiary} 100%)`, backgroundSize: '200% 100%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : notifications.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center' }}>
              <Image src="/stickers/gn.webp" alt="No notifications" width={48} height={48} unoptimized style={{ margin: '0 auto 8px', display: 'block', opacity: 0.7 }} />
              <p style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                {t('noNotifications')}
              </p>
            </div>
          ) : (
            notifications.filter(n => typeFilter === 'all' || n.type === typeFilter).map((notif) => {
              const content = (
                <div
                  key={notif.id}
                  onClick={() => { if (!notif.read) markAsRead(notif.id) }}
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
                      <Image src={`/api/avatar?url=${encodeURIComponent(notif.actor_avatar_url)}`} alt={`${notif.actor_handle || 'User'} avatar`} width={32} height={32} sizes="32px" loading="lazy" unoptimized style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    ) : (
                      getIcon(notif.type)
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 2 }}>
                      {notif.title}
                    </div>
                    <div style={{ fontSize: 12, color: tokens.colors.text.secondary, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {notif.message}
                    </div>
                    <div style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                      {formatTimeAgo(notif.created_at, language)}
                    </div>
                  </div>
                  {!notif.read && (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: tokens.colors.accent.primary, flexShrink: 0, marginTop: 6 }} />
                  )}
                </div>
              )

              return notif.link ? (
                <Link key={notif.id} href={notif.link} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {content}
                </Link>
              ) : (
                <div key={notif.id}>{content}</div>
              )
            })
          )}
          {!loading && hasMore && notifications.length > 0 && (
            <div style={{ textAlign: 'center', padding: `${tokens.spacing[3]} ${tokens.spacing[4]}` }}>
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
