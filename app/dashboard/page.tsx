'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import Link from 'next/link'
import { formatNumber } from '@/lib/design-system-helpers'

export default function DashboardPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [stats, setStats] = useState({
    following: 0,
    followers: 0,
    posts: 0,
    favorites: 0,
  })

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (data.user?.id) {
        loadStats(data.user.id)
      }
    })
  }, [])

  const loadStats = async (uid: string) => {
    // 这里应该从数据库加载真实数据
    // 暂时使用mock数据
    setStats({
      following: 12,
      followers: 156,
      posts: 8,
      favorites: 24,
    })
  }

  if (!userId) {
    return (
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={email} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
          <EmptyState 
            icon="🔒"
            title="请先登录"
            description="登录后查看个人仪表盘"
            action={
              <Link
                href="/login"
                style={{
                  padding: '12px 24px',
                  background: '#8b6fa8',
                  color: '#fff',
                  borderRadius: '12px',
                  textDecoration: 'none',
                  fontWeight: 900,
                  fontSize: '14px',
                  display: 'inline-block',
                }}
              >
                前往登录
              </Link>
            }
          />
        </main>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav email={email} />
      
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 950, marginBottom: '24px' }}>
          我的仪表盘
        </h1>

        {/* 统计卡片 */}
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '16px',
          marginBottom: '32px',
        }}>
          {[
            { label: '关注中', value: stats.following, icon: '👥', color: '#8b6fa8' },
            { label: '粉丝', value: stats.followers, icon: '⭐', color: '#2fe57d' },
            { label: '帖子', value: stats.posts, icon: '📝', color: '#4d9fff' },
            { label: '收藏', value: stats.favorites, icon: '❤️', color: '#ff7c7c' },
          ].map((stat) => (
            <div
              key={stat.label}
              style={{
                padding: '20px',
                borderRadius: '16px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                transition: 'all 200ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.transform = 'translateY(-2px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>{stat.icon}</div>
              <div style={{ fontSize: '28px', fontWeight: 950, marginBottom: '4px', color: stat.color }}>
                {formatNumber(stat.value)}
              </div>
              <div style={{ fontSize: '13px', color: '#9a9a9a' }}>{stat.label}</div>
            </div>
          ))}
        </div>

        {/* 快捷入口 */}
        <div style={{ marginBottom: '32px' }}>
          <h2 style={{ fontSize: '20px', fontWeight: 950, marginBottom: '16px' }}>快捷入口</h2>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '12px',
          }}>
            {[
              { label: '我的关注', href: '/following', icon: '👥' },
              { label: '我的收藏', href: '/favorites', icon: '❤️' },
              { label: '我的帖子', href: '/my-posts', icon: '📝' },
              { label: '通知中心', href: '/notifications', icon: '🔔' },
            ].map((item) => (
              <Link
                key={item.label}
                href={item.href}
                style={{
                  padding: '16px',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  textDecoration: 'none',
                  color: 'inherit',
                  textAlign: 'center',
                  transition: 'all 200ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(139,111,168,0.15)'
                  e.currentTarget.style.borderColor = '#8b6fa8'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                }}
              >
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>{item.icon}</div>
                <div style={{ fontSize: '14px', fontWeight: 700 }}>{item.label}</div>
              </Link>
            ))}
          </div>
        </div>

        {/* 最近动态 */}
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 950, marginBottom: '16px' }}>最近动态</h2>
          <EmptyState 
            icon="📊"
            title="暂无动态"
            description="你的关注和活动会显示在这里"
          />
        </div>
      </main>
    </div>
  )
}

