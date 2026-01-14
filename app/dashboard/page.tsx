'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import Link from 'next/link'
import { formatCompact as formatNumber } from '@/lib/utils/format'
import { formatTimeAgo } from '@/lib/utils/date'

interface Activity {
  id: string
  type: 'post' | 'comment' | 'like' | 'follow' | 'notification'
  title: string
  description?: string
  created_at: string
  href?: string
}

export default function DashboardPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [stats, setStats] = useState({
    following: 0,
    followers: 0,
    posts: 0,
    favorites: 0,
  })
  const [activities, setActivities] = useState<Activity[]>([])
  const [loadingActivities, setLoadingActivities] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (data.user?.id) {
        loadStats(data.user.id)
        loadActivities(data.user.id)
      }
    })
  }, [])

  const loadStats = async (uid: string) => {
    try {
      // 从数据库加载真实数据
      // 获取关注的人数量（他关注的人）- 使用 trader_follows 表
      const { count: followingCount } = await supabase
        .from('trader_follows')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', uid)
      
      // 获取粉丝数（关注他的人）- 使用 trader_follows 表
      const { count: followersCount } = await supabase
        .from('trader_follows')
        .select('*', { count: 'exact', head: true })
        .eq('trader_id', uid)
      
      // 获取帖子数量
      const { count: postsCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', uid)
      
      // 获取收藏数量（如果有收藏表）
      let favoritesCount = 0
      try {
        const { count, error } = await supabase
          .from('favorites')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', uid)
        if (!error && typeof count === 'number') favoritesCount = count
      } catch {
        favoritesCount = 0 // favorites 表不存在或权限不足时，安全降级
      }
      
      setStats({
        following: followingCount || 0,
        followers: followersCount || 0,
        posts: postsCount || 0,
        favorites: favoritesCount || 0,
      })
    } catch (error) {
      console.error('Error loading stats:', error)
      // 如果出错，设置为0
      setStats({
        following: 0,
        followers: 0,
        posts: 0,
        favorites: 0,
      })
    }
  }

  const loadActivities = async (uid: string) => {
    setLoadingActivities(true)
    try {
      const allActivities: Activity[] = []

      // 获取用户最近的帖子
      const { data: posts } = await supabase
        .from('posts')
        .select('id, title, created_at')
        .eq('author_id', uid)
        .order('created_at', { ascending: false })
        .limit(5)

      if (posts) {
        posts.forEach((post: any) => {
          allActivities.push({
            id: `post-${post.id}`,
            type: 'post',
            title: '发布了帖子',
            description: post.title,
            created_at: post.created_at,
            href: `/groups?post=${post.id}`,
          })
        })
      }

      // 获取用户最近的评论
      const { data: comments } = await supabase
        .from('comments')
        .select('id, content, created_at, post_id')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(5)

      if (comments) {
        comments.forEach((comment: any) => {
          allActivities.push({
            id: `comment-${comment.id}`,
            type: 'comment',
            title: '发表了评论',
            description: comment.content?.substring(0, 50) + (comment.content?.length > 50 ? '...' : ''),
            created_at: comment.created_at,
            href: `/groups?post=${comment.post_id}`,
          })
        })
      }

      // 获取最近收到的通知
      const { data: notifications } = await supabase
        .from('notifications')
        .select('id, type, content, created_at, read')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(5)

      if (notifications) {
        notifications.forEach((notif: any) => {
          let title = '收到通知'
          if (notif.type === 'follow') title = '有人关注了你'
          if (notif.type === 'like') title = '有人点赞了你的帖子'
          if (notif.type === 'comment') title = '有人评论了你的帖子'
          if (notif.type === 'mention') title = '有人提及了你'

          allActivities.push({
            id: `notif-${notif.id}`,
            type: 'notification',
            title,
            description: notif.content,
            created_at: notif.created_at,
            href: '/notifications',
          })
        })
      }

      // 按时间排序
      allActivities.sort((a, b) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )

      setActivities(allActivities.slice(0, 10))
    } catch (error) {
      console.error('Error loading activities:', error)
    } finally {
      setLoadingActivities(false)
    }
  }

  if (!userId) {
    return (
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={email} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
          <EmptyState 
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
            { label: '关注中', value: stats.following, color: '#8b6fa8' },
            { label: '粉丝', value: stats.followers, color: '#2fe57d' },
            { label: '帖子', value: stats.posts, color: '#4d9fff' },
            { label: '收藏', value: stats.favorites, color: '#ff7c7c' },
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
              { label: '我的关注', href: '/following' },
              { label: '我的收藏', href: '/favorites' },
              { label: '我的帖子', href: '/my-posts' },
              { label: '通知中心', href: '/notifications' },
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
                <div style={{ fontSize: '14px', fontWeight: 700 }}>{item.label}</div>
              </Link>
            ))}
          </div>
        </div>

        {/* 最近动态 */}
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 950, marginBottom: '16px' }}>最近动态</h2>
          {loadingActivities ? (
            <div style={{ 
              padding: '40px', 
              textAlign: 'center', 
              color: '#9a9a9a',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}>
              加载中...
            </div>
          ) : activities.length === 0 ? (
            <EmptyState 
              title="暂无动态"
              description="你的关注和活动会显示在这里"
            />
          ) : (
            <div style={{
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '16px',
              border: '1px solid rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}>
              {activities.map((activity, index) => (
                <Link
                  key={activity.id}
                  href={activity.href || '#'}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '16px',
                    padding: '16px 20px',
                    borderBottom: index < activities.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: 'background 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: activity.type === 'post' ? 'rgba(77,159,255,0.15)'
                      : activity.type === 'comment' ? 'rgba(139,111,168,0.15)'
                      : activity.type === 'notification' ? 'rgba(255,193,7,0.15)'
                      : 'rgba(47,229,125,0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    fontWeight: 900,
                    color: activity.type === 'post' ? '#4d9fff'
                      : activity.type === 'comment' ? '#8b6fa8'
                      : activity.type === 'notification' ? '#ffc107'
                      : '#2fe57d',
                    flexShrink: 0,
                  }}>
                    {activity.type === 'post' ? '帖'
                      : activity.type === 'comment' ? '评'
                      : activity.type === 'notification' ? '通'
                      : '关'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ 
                      fontSize: 14, 
                      fontWeight: 700,
                      marginBottom: 4,
                    }}>
                      {activity.title}
                    </div>
                    {activity.description && (
                      <div style={{ 
                        fontSize: 13, 
                        color: '#9a9a9a',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        {activity.description}
                      </div>
                    )}
                    <div style={{ 
                      fontSize: 12, 
                      color: '#666',
                      marginTop: 4,
                    }}>
                      {formatTimeAgo(activity.created_at)}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

