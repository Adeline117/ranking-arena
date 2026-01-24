'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import { formatTimeAgo } from '@/lib/utils/date'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { getCsrfHeaders } from '@/lib/api/client'
import { type NotificationWithActor } from '@/lib/types'

type Notification = NotificationWithActor

export default function NotificationsList() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const setUnreadNotifications = useInboxStore((s) => s.setUnreadNotifications)
  const unreadNotifications = useInboxStore((s) => s.unreadNotifications)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  const loadNotifications = useCallback(async () => {
    if (!accessToken) return
    try {
      setLoading(true)
      const response = await fetch('/api/notifications', {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      const result = await response.json()
      if (response.ok) {
        const data = result.data || result
        setNotifications(data.notifications || [])
        setUnreadNotifications(data.unread_count || 0)
      }
    } catch (err) {
      console.error('Failed to load notifications:', err)
    } finally {
      setLoading(false)
    }
  }, [accessToken, setUnreadNotifications])

  useEffect(() => {
    if (accessToken) loadNotifications()
  }, [accessToken, loadNotifications])

  const markAllAsRead = useCallback(() => {
    if (!accessToken) return
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    setUnreadNotifications(0)
    fetch('/api/notifications', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ mark_all: true }),
    }).catch(() => {})
  }, [accessToken, setUnreadNotifications])

  const markAsRead = useCallback((id: string) => {
    if (!accessToken) return
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n))
    setUnreadNotifications(Math.max(0, unreadNotifications - 1))
    fetch('/api/notifications', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        ...getCsrfHeaders(),
      },
      body: JSON.stringify({ notification_id: id }),
    }).catch(() => {})
  }, [accessToken, unreadNotifications, setUnreadNotifications])

  const getIcon = (type: string) => {
    if (type === 'follow') return '关'
    if (type === 'like') return '赞'
    if (type === 'comment') return '评'
    if (type === 'mention') return '@'
    return '通'
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
            通知
          </span>
          {unreadNotifications > 0 && (
            <span
              style={{
                padding: '1px 6px',
                borderRadius: 10,
                background: tokens.colors.accent.primary,
                color: '#fff',
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
            全部已读
          </button>
        )}
      </div>

      {/* Notifications list */}
      {!collapsed && (
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
              加载中...
            </div>
          ) : notifications.length === 0 ? (
            <div style={{ padding: tokens.spacing[4], textAlign: 'center', color: tokens.colors.text.tertiary, fontSize: 13 }}>
              暂无通知
            </div>
          ) : (
            notifications.slice(0, 20).map((notif) => {
              const content = (
                <div
                  key={notif.id}
                  onClick={() => { if (!notif.read) markAsRead(notif.id) }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    background: notif.read ? 'transparent' : 'rgba(139,111,168,0.06)',
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
                      <img src={notif.actor_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
                      {formatTimeAgo(notif.created_at)}
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
        </div>
      )}
    </div>
  )
}
