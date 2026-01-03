'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import Link from 'next/link'

type Notification = {
  id: string
  type: 'follow' | 'like' | 'comment' | 'system'
  title: string
  message: string
  link?: string
  read: boolean
  created_at: string
}

export default function NotificationsPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })

    // 加载通知（暂时使用mock数据）
    setTimeout(() => {
      setNotifications([
        {
          id: '1',
          type: 'follow',
          title: '新粉丝',
          message: '用户 @trader123 关注了你',
          link: '/user/trader123',
          read: false,
          created_at: new Date().toISOString(),
        },
      ])
      setLoading(false)
    }, 500)
  }, [])

  const getIcon = (type: string) => {
    if (type === 'follow') return '👥'
    if (type === 'like') return '❤️'
    if (type === 'comment') return '💬'
    return '🔔'
  }

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav email={email} />
      
      <main style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 950, marginBottom: '24px' }}>
          通知中心
        </h1>

        {loading ? (
          <div style={{ color: '#9a9a9a', textAlign: 'center', padding: '40px' }}>
            加载中...
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
                  style={{
                    padding: '16px',
                    borderRadius: '12px',
                    background: notif.read ? 'rgba(255,255,255,0.02)' : 'rgba(139,111,168,0.1)',
                    border: `1px solid ${notif.read ? 'rgba(255,255,255,0.06)' : 'rgba(139,111,168,0.3)'}`,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    transition: 'all 200ms ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = notif.read 
                      ? 'rgba(255,255,255,0.04)' 
                      : 'rgba(139,111,168,0.15)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = notif.read 
                      ? 'rgba(255,255,255,0.02)' 
                      : 'rgba(139,111,168,0.1)'
                  }}
                >
                  <div style={{ fontSize: '24px' }}>{getIcon(notif.type)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '15px', fontWeight: 900, marginBottom: '4px' }}>
                      {notif.title}
                    </div>
                    <div style={{ fontSize: '13px', color: '#bdbdbd', marginBottom: '4px' }}>
                      {notif.message}
                    </div>
                    <div style={{ fontSize: '11px', color: '#777' }}>
                      {new Date(notif.created_at).toLocaleString('zh-CN')}
                    </div>
                  </div>
                  {!notif.read && (
                    <div style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: '#8b6fa8',
                      marginTop: '8px',
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

