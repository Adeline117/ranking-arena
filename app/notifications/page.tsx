'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { Box, Text } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import PullToRefreshWrapper from '@/app/components/ui/PullToRefreshWrapper'
import { features } from '@/lib/features'

const SOCIAL_NOTIFICATION_TYPES = ['post_reply', 'new_follower', 'group_update', 'like', 'comment', 'follow', 'mention']

// ============================================
// 类型
// ============================================

interface Notification {
  id: string
  user_id: string
  type: string
  title: string
  message: string
  link?: string
  read: boolean
  actor_id?: string
  reference_id?: string
  created_at: string
  actor_handle?: string
  actor_avatar_url?: string
}

// ============================================
// 时间格式化
// ============================================

function timeAgo(dateStr: string, t: (key: string) => string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.floor((now - then) / 1000)

  if (diff < 60) return t('timeSecondsAgo').replace('{n}', String(diff))
  if (diff < 3600) return t('timeMinutesAgo').replace('{n}', String(Math.floor(diff / 60)))
  if (diff < 86400) return t('timeHoursAgo').replace('{n}', String(Math.floor(diff / 3600)))
  return t('timeDaysAgo').replace('{n}', String(Math.floor(diff / 86400)))
}

// ============================================
// 严重程度颜色
// ============================================

function getSeverityFromMessage(message: string): 'critical' | 'warning' | 'info' {
  // 简单推断：根据变动幅度判断
  const numMatch = message.match(/从 [+-]?([\d.]+)%? 变为 [+-]?([\d.]+)%?/)
    || message.match(/from [+-]?([\d.]+)%? to [+-]?([\d.]+)%?/)
  if (numMatch) {
    const oldVal = parseFloat(numMatch[1])
    const newVal = parseFloat(numMatch[2])
    const change = Math.abs(newVal - oldVal)
    if (change >= 40) return 'critical'
    if (change >= 15) return 'warning'
  }
  return 'info'
}

const severityColors = {
  critical: 'var(--color-accent-error)',
  warning: 'var(--color-score-average)',
  info: 'var(--color-score-profitability)',
}

const severityIcons = {
  critical: '!',
  warning: '~',
  info: 'i',
}

// Notification type display config
const NOTIFICATION_TYPE_CONFIG: Record<string, { icon: string; color: string; filterLabel?: { zh: string; en: string } }> = {
  trader_alert: { icon: 'chart', color: 'var(--color-score-profitability)' },
  post_reply: { icon: 'reply', color: 'var(--color-verified-web3)', filterLabel: { zh: '帖子回复', en: 'Replies' } },
  new_follower: { icon: 'user', color: 'var(--color-score-great)', filterLabel: { zh: '新粉丝', en: 'Followers' } },
  group_update: { icon: 'megaphone', color: 'var(--color-score-average)', filterLabel: { zh: '群组更新', en: 'Groups' } },
  follow: { icon: 'user', color: 'var(--color-score-great)' },
  like: { icon: 'heart', color: 'var(--color-accent-error)' },
  comment: { icon: 'reply', color: 'var(--color-verified-web3)' },
  system: { icon: 'bell', color: 'var(--color-score-low)' },
  mention: { icon: '@', color: 'var(--color-score-profitability)' },
  message: { icon: 'mail', color: 'var(--color-chart-indigo)' },
}

// SVG icon renderer for notification types (no emoji)
function NotificationIconSvg({ type, size = 16 }: { type: string; size?: number }) {
  const color = NOTIFICATION_TYPE_CONFIG[type]?.color || 'var(--color-score-low)'
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const iconKey = NOTIFICATION_TYPE_CONFIG[type]?.icon || 'bell'

  switch (iconKey) {
    case 'chart':
      return <svg {...props}><path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" /></svg>
    case 'reply':
      return <svg {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
    case 'user':
      return <svg {...props}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
    case 'megaphone':
      return <svg {...props}><path d="m3 11 18-5v12L3 13v-2z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" /></svg>
    case 'heart':
      return <svg {...props} fill={color}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
    case 'mail':
      return <svg {...props}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>
    case '@':
      return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" /></svg>
    case 'bell':
    default:
      return <svg {...props}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
  }
}

function _getNotificationIcon(type: string): string {
  return NOTIFICATION_TYPE_CONFIG[type]?.icon || 'bell'
}

function getNotificationBorderColor(type: string, severity: 'critical' | 'warning' | 'info'): string {
  if (type === 'trader_alert') return severityColors[severity]
  return NOTIFICATION_TYPE_CONFIG[type]?.color || 'transparent'
}

// ============================================
// 主组件
// ============================================

export default function NotificationsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { email, accessToken, authChecked } = useAuthSession()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState<string>('all')

  // 未登录跳转
  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login')
    }
  }, [authChecked, accessToken, router])

  // 加载通知
  const loadNotifications = useCallback(async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const res = await fetch('/api/notifications?limit=100', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        showToast(t('loadNotificationsFailed'), 'error')
        return
      }
      const result = await res.json()
      const data = result.data || result
      setNotifications(data.notifications || [])
    } catch {
      showToast(t('loadNotificationsFailed'), 'error')
    } finally {
      setLoading(false)
    }
  }, [accessToken, t, showToast])

  useEffect(() => {
    if (accessToken) loadNotifications()
  }, [accessToken, loadNotifications])

  // 全部标为已读
  const markAllRead = async () => {
    if (!accessToken) return
    try {
      await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ mark_all: true }),
      })
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    } catch {
      // Intentionally swallowed: mark-all-read is best-effort, UI already updated optimistically
    }
  }

  // 标记单条为已读并跳转
  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.read && accessToken) {
      // 乐观更新
      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n))
      )
      // 异步标为已读
      fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ notification_id: notification.id }),
      }).catch(() => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, read: false } : n))
        )
      })
    }
    if (notification.link) {
      router.push(notification.link)
    }
  }

  // Filter out social notifications when social is off
  const visibleNotifications = features.social
    ? notifications
    : notifications.filter((n) => !SOCIAL_NOTIFICATION_TYPES.includes(n.type))

  // Reset filter if it's a social type and social is off
  const effectiveFilterType = (!features.social && SOCIAL_NOTIFICATION_TYPES.includes(filterType))
    ? 'all'
    : filterType

  // 过滤后的列表
  const filtered = effectiveFilterType === 'all'
    ? visibleNotifications
    : visibleNotifications.filter((n) => n.type === effectiveFilterType)

  const traderAlertCount = visibleNotifications.filter((n) => n.type === 'trader_alert').length
  const postReplyCount = visibleNotifications.filter((n) => n.type === 'post_reply').length
  const newFollowerCount = visibleNotifications.filter((n) => n.type === 'new_follower').length
  const groupUpdateCount = visibleNotifications.filter((n) => n.type === 'group_update').length
  const unreadCount = visibleNotifications.filter((n) => !n.read).length

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <PullToRefreshWrapper onRefresh={loadNotifications}>
      <Box style={{ maxWidth: 700, margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`, paddingBottom: 80 }}>
        {/* 标题行 */}
        <Box style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
          padding: `${tokens.spacing[3]} 0`,
        }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Text size="lg" weight="bold">{t('notifications')}</Text>
            {unreadCount > 0 && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 20,
                height: 20,
                borderRadius: 10,
                background: tokens.colors.accent.error,
                color: tokens.colors.white,
                fontSize: 11,
                fontWeight: 600,
                padding: '0 6px',
              }}>
                {unreadCount}
              </span>
            )}
          </Box>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.accent.brand,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: 500,
              }}
            >
              {t('markAllRead')}
            </button>
          )}
        </Box>

        {/* 过滤标签 */}
        <Box className="notif-filters" style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
          overflowX: 'auto',
          paddingBottom: tokens.spacing[1],
          WebkitOverflowScrolling: 'touch',
          msOverflowStyle: 'none',
          scrollbarWidth: 'none',
        }}>
          <FilterTab
            label={t('all')}
            count={visibleNotifications.length}
            active={filterType === 'all'}
            onClick={() => setFilterType('all')}
          />
          <FilterTab
            label={t('traderMovementAlerts')}
            count={traderAlertCount}
            active={filterType === 'trader_alert'}
            onClick={() => setFilterType('trader_alert')}
          />
          {features.social && postReplyCount > 0 && (
            <FilterTab
              label={language === 'zh' ? '帖子回复' : 'Replies'}
              count={postReplyCount}
              active={filterType === 'post_reply'}
              onClick={() => setFilterType('post_reply')}
            />
          )}
          {features.social && newFollowerCount > 0 && (
            <FilterTab
              label={language === 'zh' ? '新粉丝' : 'Followers'}
              count={newFollowerCount}
              active={filterType === 'new_follower'}
              onClick={() => setFilterType('new_follower')}
            />
          )}
          {features.social && groupUpdateCount > 0 && (
            <FilterTab
              label={language === 'zh' ? '群组更新' : 'Groups'}
              count={groupUpdateCount}
              active={filterType === 'group_update'}
              onClick={() => setFilterType('group_update')}
            />
          )}
        </Box>

        {/* 通知列表 */}
        {loading ? (
          <ListSkeleton count={5} gap={8} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={t('noAlerts')}
            description={t('noAlertsDesc')}
          />
        ) : (
          <Box style={{
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[1],
          }}>
            {filtered.map((n) => {
              const severity = n.type === 'trader_alert' ? getSeverityFromMessage(n.message) : 'info'
              return (
                <Box
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  style={{
                    display: 'flex',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[3],
                    borderRadius: tokens.radius.md,
                    cursor: n.link ? 'pointer' : 'default',
                    background: n.read ? 'transparent' : tokens.colors.bg.secondary,
                    transition: `background ${tokens.transition.base}`,
                    borderLeft: `3px solid ${getNotificationBorderColor(n.type, severity)}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = n.read ? 'transparent' : tokens.colors.bg.secondary
                  }}
                >
                  {/* 图标 */}
                  <Box style={{
                    flexShrink: 0,
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: n.type === 'trader_alert'
                      ? severityColors[severity] + '15'
                      : (NOTIFICATION_TYPE_CONFIG[n.type]?.color || tokens.colors.bg.tertiary) + '15',
                    fontSize: 14,
                  }}>
                    {n.type === 'trader_alert' ? severityIcons[severity] : <NotificationIconSvg type={n.type} size={16} />}
                  </Box>

                  {/* 内容 */}
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
                      <Text size="sm" weight={n.read ? 'normal' : 'semibold'} style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 1,
                        WebkitBoxOrient: 'vertical',
                      }}>
                        {n.title}
                      </Text>
                      <Text size="xs" color="tertiary" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {timeAgo(n.created_at, t)}
                      </Text>
                    </Box>
                    <Text size="xs" color="secondary" style={{
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                    }}>
                      {n.message}
                    </Text>
                    {n.link && (
                      <Text size="xs" style={{
                        color: tokens.colors.accent.brand,
                        marginTop: 4,
                      }}>
                        {t('viewDetails')} →
                      </Text>
                    )}
                  </Box>

                  {/* 未读标记 */}
                  {!n.read && (
                    <Box style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: tokens.colors.accent.brand,
                      flexShrink: 0,
                      marginTop: 6,
                    }} />
                  )}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
      <style>{`
        .notif-filters::-webkit-scrollbar { display: none; }
      `}</style>
      </PullToRefreshWrapper>
      <MobileBottomNav />
    </Box>
  )
}

// ============================================
// 过滤标签组件
// ============================================

function FilterTab({ label, count, active, onClick }: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.full,
        border: 'none',
        cursor: 'pointer',
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: active ? 600 : 400,
        background: active ? tokens.colors.accent.brand + '20' : tokens.colors.bg.secondary,
        color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary,
        transition: `all ${tokens.transition.base}`,
      }}
    >
      {label}
      <span style={{
        fontSize: 10,
        background: active ? tokens.colors.accent.brand + '30' : tokens.colors.bg.tertiary,
        borderRadius: 10,
        padding: '1px 6px',
        minWidth: 18,
        textAlign: 'center',
      }}>
        {count}
      </span>
    </button>
  )
}
