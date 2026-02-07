'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'
import EmptyState from '@/app/components/ui/EmptyState'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'

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
  critical: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',
}

const severityIcons = {
  critical: '!',
  warning: '~',
  info: 'i',
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
  const [filterType, setFilterType] = useState<'all' | 'trader_alert'>('all')

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
      // ignore
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
        // 回滚
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, read: false } : n))
        )
      })
    }
    if (notification.link) {
      router.push(notification.link)
    }
  }

  // 过滤后的列表
  const filtered = filterType === 'all'
    ? notifications
    : notifications.filter((n) => n.type === 'trader_alert')

  const traderAlertCount = notifications.filter((n) => n.type === 'trader_alert').length
  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
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
                color: '#fff',
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
        <Box style={{
          display: 'flex',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[4],
        }}>
          <FilterTab
            label={t('all')}
            count={notifications.length}
            active={filterType === 'all'}
            onClick={() => setFilterType('all')}
          />
          <FilterTab
            label={t('traderMovementAlerts')}
            count={traderAlertCount}
            active={filterType === 'trader_alert'}
            onClick={() => setFilterType('trader_alert')}
          />
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
                    borderLeft: n.type === 'trader_alert'
                      ? `3px solid ${severityColors[severity]}`
                      : '3px solid transparent',
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
                      : tokens.colors.bg.tertiary,
                    fontSize: 14,
                  }}>
                    {n.type === 'trader_alert' ? severityIcons[severity] : 'N'}
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
