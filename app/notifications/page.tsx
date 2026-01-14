'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { formatTimeAgo } from '@/lib/utils/date'
import { type NotificationWithActor } from '@/lib/types'
import { useToast } from '@/app/components/UI/Toast'

type Notification = NotificationWithActor
type NotificationType = 'all' | 'follow' | 'like' | 'comment' | 'mention'

const NOTIFICATIONS_PER_PAGE = 20

export default function NotificationsPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<NotificationType>('all')
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 检查登录状态
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.push('/login')
        return
      }
      setEmail(session.user?.email ?? null)
      setAccessToken(session.access_token)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.push('/login')
        return
      }
      setEmail(session.user?.email ?? null)
      setAccessToken(session.access_token)
    })

    return () => subscription.unsubscribe()
  }, [router])

  // 加载通知
  const loadNotifications = useCallback(async () => {
    if (!accessToken) return

    try {
      setLoading(true)
      setError(null)

      const response = await fetch('/api/notifications', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || '获取通知失败')
      }

      setNotifications(data.notifications || [])
      setUnreadCount(data.unread_count || 0)
    } catch (err: any) {
      console.error('[Notifications] 加载失败:', err)
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    if (accessToken) {
      loadNotifications()
    }
  }, [accessToken, loadNotifications])

  // 标记单个为已读
  const markAsRead = async (notificationId: string) => {
    if (!accessToken) return

    try {
      await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ notification_id: notificationId }),
      })

      // 更新本地状态
      setNotifications(prev => prev.map(n => 
        n.id === notificationId ? { ...n, read: true } : n
      ))
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (err) {
      console.error('[Notifications] 标记已读失败:', err)
    }
  }

  // 标记全部为已读
  const markAllAsRead = async () => {
    if (!accessToken) return

    try {
      await fetch('/api/notifications', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ mark_all: true }),
      })

      // 更新本地状态
      setNotifications(prev => prev.map(n => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('[Notifications] 标记全部已读失败:', err)
    }
  }

  const getIcon = (type: string) => {
    if (type === 'follow') return '关'
    if (type === 'like') return '赞'
    if (type === 'comment') return '评'
    if (type === 'mention') return '@'
    return '通'
  }

  // Load more notifications
  const loadMore = async () => {
    if (!accessToken || loadingMore || !hasMore) return

    setLoadingMore(true)
    try {
      const lastNotif = notifications[notifications.length - 1]
      const response = await fetch(`/api/notifications?before=${lastNotif?.created_at || ''}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || '获取通知失败')
      }

      const newNotifications = data.notifications || []
      if (newNotifications.length < NOTIFICATIONS_PER_PAGE) {
        setHasMore(false)
      }
      setNotifications(prev => [...prev, ...newNotifications])
    } catch (err: any) {
      console.error('[Notifications] 加载更多失败:', err)
      showToast('加载更多失败', 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  // Delete single notification
  const deleteNotification = async (notificationId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    if (!accessToken) return

    setDeletingId(notificationId)
    try {
      const response = await fetch('/api/notifications', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ notification_id: notificationId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || '删除失败')
      }

      // Remove from local state
      const deletedNotif = notifications.find(n => n.id === notificationId)
      setNotifications(prev => prev.filter(n => n.id !== notificationId))
      if (deletedNotif && !deletedNotif.read) {
        setUnreadCount(prev => Math.max(0, prev - 1))
      }
      showToast('已删除', 'success')
    } catch (err: any) {
      console.error('[Notifications] 删除失败:', err)
      showToast('删除失败', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  // Filter notifications by type
  const filteredNotifications = typeFilter === 'all' 
    ? notifications 
    : notifications.filter(n => n.type === typeFilter)

  const handleNotificationClick = (notif: Notification) => {
    if (!notif.read) {
      markAsRead(notif.id)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 950 }}>
            通知中心
            {unreadCount > 0 && (
              <span style={{
                marginLeft: 12,
                padding: '4px 10px',
                background: tokens.colors.accent.primary,
                color: '#fff',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 700,
              }}>
                {unreadCount} 条未读
              </span>
            )}
          </h1>
          {unreadCount > 0 && (
            <button
              onClick={markAllAsRead}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: 8,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.accent.primary
                e.currentTarget.style.color = tokens.colors.accent.primary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.color = tokens.colors.text.secondary
              }}
            >
              全部标为已读
            </button>
          )}
        </div>

        {/* Type Filters */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {[
            { key: 'all' as NotificationType, label: '全部' },
            { key: 'follow' as NotificationType, label: '关注' },
            { key: 'like' as NotificationType, label: '点赞' },
            { key: 'comment' as NotificationType, label: '评论' },
            { key: 'mention' as NotificationType, label: '提及' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTypeFilter(key)}
              style={{
                padding: '6px 14px',
                borderRadius: 20,
                border: `1px solid ${typeFilter === key ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: typeFilter === key ? tokens.colors.accent.primary : 'transparent',
                color: typeFilter === key ? '#fff' : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                transition: 'all 0.2s ease',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ color: tokens.colors.text.tertiary, textAlign: 'center', padding: '40px' }}>
            加载中...
          </div>
        ) : error ? (
          <div style={{ color: tokens.colors.text.tertiary, textAlign: 'center', padding: '40px' }}>
            {error}
            <button
              onClick={loadNotifications}
              style={{
                marginLeft: 12,
                padding: '8px 16px',
                background: tokens.colors.accent.primary,
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              重试
            </button>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <EmptyState 
            title={typeFilter === 'all' ? '暂无通知' : `暂无${typeFilter === 'follow' ? '关注' : typeFilter === 'like' ? '点赞' : typeFilter === 'comment' ? '评论' : '提及'}通知`}
            description={typeFilter === 'all' ? '当你收到关注、点赞或评论时会显示在这里' : '切换到其他类型查看更多通知'}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredNotifications.map((notif) => {
              const Content = (
                <div
                  onClick={() => handleNotificationClick(notif)}
                  style={{
                    padding: '16px',
                    borderRadius: '12px',
                    background: notif.read ? tokens.colors.bg.secondary : 'rgba(139,111,168,0.1)',
                    border: `1px solid ${notif.read ? tokens.colors.border.primary : 'rgba(139,111,168,0.3)'}`,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    transition: 'all 200ms ease',
                    cursor: notif.link ? 'pointer' : 'default',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = notif.read 
                      ? tokens.colors.bg.tertiary || 'rgba(255,255,255,0.04)'
                      : 'rgba(139,111,168,0.15)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = notif.read 
                      ? tokens.colors.bg.secondary
                      : 'rgba(139,111,168,0.1)'
                  }}
                >
                  {/* 头像或图标 */}
                  <div style={{ 
                    width: 40, 
                    height: 40, 
                    borderRadius: '50%',
                    background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '20px',
                    flexShrink: 0,
                    overflow: 'hidden',
                  }}>
                    {notif.actor_avatar_url ? (
                      <img 
                        src={notif.actor_avatar_url} 
                        alt="" 
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    ) : (
                      getIcon(notif.type)
                    )}
                  </div>

                  {/* 内容 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '15px', fontWeight: 900, marginBottom: '4px', color: tokens.colors.text.primary }}>
                      {notif.title}
                    </div>
                    <div style={{ fontSize: '13px', color: tokens.colors.text.secondary, marginBottom: '4px', lineHeight: 1.5 }}>
                      {notif.message}
                    </div>
                    <div style={{ fontSize: '11px', color: tokens.colors.text.tertiary }}>
                      {formatTimeAgo(notif.created_at)}
                    </div>
                  </div>

                  {/* 未读指示器 & 删除按钮 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                    {!notif.read && (
                      <div style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: tokens.colors.accent.primary,
                        marginTop: '6px',
                      }} />
                    )}
                    <button
                      onClick={(e) => deleteNotification(notif.id, e)}
                      disabled={deletingId === notif.id}
                      style={{
                        padding: '4px 8px',
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 4,
                        color: tokens.colors.text.tertiary,
                        cursor: deletingId === notif.id ? 'not-allowed' : 'pointer',
                        fontSize: 12,
                        opacity: deletingId === notif.id ? 0.5 : 1,
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (deletingId !== notif.id) {
                          e.currentTarget.style.color = '#ff4d4d'
                          e.currentTarget.style.background = 'rgba(255, 77, 77, 0.1)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = tokens.colors.text.tertiary
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {deletingId === notif.id ? '...' : '删除'}
                    </button>
                  </div>
                </div>
              )

              return notif.link ? (
                <Link key={notif.id} href={notif.link} style={{ textDecoration: 'none', color: 'inherit' }}>
                  {Content}
                </Link>
              ) : (
                <div key={notif.id}>{Content}</div>
              )
            })}

            {/* Load More Button */}
            {hasMore && filteredNotifications.length >= NOTIFICATIONS_PER_PAGE && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                style={{
                  padding: '12px 24px',
                  background: 'transparent',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: 8,
                  color: tokens.colors.text.secondary,
                  cursor: loadingMore ? 'not-allowed' : 'pointer',
                  fontSize: 14,
                  fontWeight: 700,
                  width: '100%',
                  marginTop: '8px',
                  transition: 'all 0.2s ease',
                  opacity: loadingMore ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!loadingMore) {
                    e.currentTarget.style.borderColor = tokens.colors.accent.primary
                    e.currentTarget.style.color = tokens.colors.accent.primary
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = tokens.colors.border.primary
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }}
              >
                {loadingMore ? '加载中...' : '加载更多'}
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
