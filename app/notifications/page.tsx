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

type Notification = NotificationWithActor

export default function NotificationsPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
    if (type === 'follow') return '👥'
    if (type === 'like') return '❤️'
    if (type === 'comment') return '💬'
    if (type === 'mention') return '@'
    return '🔔'
  }

  const handleNotificationClick = (notif: Notification) => {
    if (!notif.read) {
      markAsRead(notif.id)
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
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
        ) : notifications.length === 0 ? (
          <EmptyState 
            icon="🔔"
            title="暂无通知"
            description="当你收到关注、点赞或评论时会显示在这里"
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {notifications.map((notif) => {
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

                  {/* 未读指示器 */}
                  {!notif.read && (
                    <div style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      background: tokens.colors.accent.primary,
                      flexShrink: 0,
                      marginTop: '6px',
                    }} />
                  )}
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
          </div>
        )}
      </main>
    </div>
  )
}
