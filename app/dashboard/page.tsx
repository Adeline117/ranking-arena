'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import Avatar from '@/app/components/UI/Avatar'
import EmptyState from '@/app/components/UI/EmptyState'
import Link from 'next/link'
import { formatCompact as formatNumber } from '@/lib/utils/format'
import { formatTimeAgo } from '@/lib/utils/date'
import { 
  UserIcon, 
  NotificationIcon, 
  ChartIcon, 
  MessageIcon,
  SettingsIcon,
  SearchIcon
} from '@/app/components/Icons'

interface Activity {
  id: string
  type: 'post' | 'comment' | 'like' | 'follow' | 'notification' | 'message'
  title: string
  description?: string
  created_at: string
  href?: string
}

interface UserProfile {
  handle: string
  bio?: string
  avatar_url?: string
}

export default function DashboardPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [stats, setStats] = useState({
    following: 0,
    followers: 0,
    posts: 0,
    favorites: 0,
    unreadMessages: 0,
    unreadNotifications: 0,
  })
  const [activities, setActivities] = useState<Activity[]>([])
  const [loadingActivities, setLoadingActivities] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // 注入响应式网格样式
  useEffect(() => {
    if (typeof document === 'undefined') return
    const styleId = 'dashboard-grid-style'
    if (document.getElementById(styleId)) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = '@media (max-width: 900px) { .dashboard-grid { grid-template-columns: 1fr !important; } }'
    document.head.appendChild(style)
  }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (data.user?.id) {
        loadProfile(data.user.id)
        loadStats(data.user.id)
        loadActivities(data.user.id)
      }
    })
  }, [])

  const loadProfile = async (uid: string) => {
    try {
      const { data } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url')
        .eq('id', uid)
        .maybeSingle()
      
      if (data) {
        setProfile(data)
      }
    } catch (error) {
      console.error('Error loading profile:', error)
    }
  }

  const loadStats = async (uid: string) => {
    try {
      // 获取关注的人数量
      const { count: followingCount } = await supabase
        .from('trader_follows')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', uid)
      
      // 获取粉丝数
      const { count: followersCount } = await supabase
        .from('trader_follows')
        .select('*', { count: 'exact', head: true })
        .eq('trader_id', uid)
      
      // 获取帖子数量
      const { count: postsCount } = await supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', uid)
      
      // 获取收藏数量
      let favoritesCount = 0
      try {
        const { count, error } = await supabase
          .from('favorites')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', uid)
        if (!error && typeof count === 'number') favoritesCount = count
      } catch {
        favoritesCount = 0
      }

      // 获取未读私信数
      let unreadMessages = 0
      try {
        const { count, error } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', uid)
          .eq('read', false)
        if (!error && typeof count === 'number') unreadMessages = count
      } catch {
        unreadMessages = 0
      }

      // 获取未读通知数
      let unreadNotifications = 0
      try {
        const { count, error } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', uid)
          .eq('read', false)
        if (!error && typeof count === 'number') unreadNotifications = count
      } catch {
        unreadNotifications = 0
      }
      
      setStats({
        following: followingCount || 0,
        followers: followersCount || 0,
        posts: postsCount || 0,
        favorites: favoritesCount || 0,
        unreadMessages,
        unreadNotifications,
      })
    } catch (error) {
      console.error('Error loading stats:', error)
      setStats({
        following: 0,
        followers: 0,
        posts: 0,
        favorites: 0,
        unreadMessages: 0,
        unreadNotifications: 0,
      })
    }
  }

  const loadActivities = async (uid: string) => {
    setLoadingActivities(true)
    setLoadError(null)
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
        .select('id, type, message, created_at, read')
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
          if (notif.type === 'message') title = '收到新私信'

          allActivities.push({
            id: `notif-${notif.id}`,
            type: notif.type === 'message' ? 'message' : 'notification',
            title,
            description: notif.message,
            created_at: notif.created_at,
            href: notif.type === 'message' ? '/messages' : '/notifications',
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
      setLoadError('加载动态失败')
    } finally {
      setLoadingActivities(false)
    }
  }

  const handleRetry = () => {
    if (userId) {
      loadProfile(userId)
      loadStats(userId)
      loadActivities(userId)
    }
  }

  // 获取活动类型图标和颜色
  const getActivityStyle = (type: Activity['type']) => {
    switch (type) {
      case 'post':
        return { bg: 'rgba(77,159,255,0.15)', color: '#4d9fff', icon: '帖' }
      case 'comment':
        return { bg: 'rgba(139,111,168,0.15)', color: '#8b6fa8', icon: '评' }
      case 'notification':
        return { bg: 'rgba(255,193,7,0.15)', color: '#ffc107', icon: '通' }
      case 'message':
        return { bg: 'rgba(139,111,168,0.15)', color: '#8b6fa8', icon: '信' }
      case 'follow':
        return { bg: 'rgba(47,229,125,0.15)', color: '#2fe57d', icon: '关' }
      default:
        return { bg: 'rgba(255,255,255,0.1)', color: '#9a9a9a', icon: '?' }
    }
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
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
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box 
        as="main" 
        style={{ 
          maxWidth: 1200, 
          margin: '0 auto', 
          padding: `${tokens.spacing[6]} ${tokens.spacing[4]}`,
        }}
      >
        {/* 顶部用户信息卡片 */}
        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{
            marginBottom: tokens.spacing[6],
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[6],
            flexWrap: 'wrap',
          }}
        >
          {/* 用户头像和基本信息 */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], flex: '1 1 300px' }}>
            <Avatar
              userId={userId}
              name={profile?.handle || email}
              avatarUrl={profile?.avatar_url}
              size={72}
            />
            <Box>
              <Text size="xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
                {profile?.handle ? `@${profile.handle}` : '欢迎回来'}
              </Text>
              {profile?.bio && (
                <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                  {profile.bio.length > 60 ? profile.bio.slice(0, 60) + '...' : profile.bio}
                </Text>
              )}
              <Box style={{ display: 'flex', gap: tokens.spacing[4] }}>
                <Box>
                  <Text size="lg" weight="black" style={{ color: '#8b6fa8' }}>
                    {formatNumber(stats.followers)}
                  </Text>
                  <Text size="xs" color="tertiary">粉丝</Text>
                </Box>
                <Box>
                  <Text size="lg" weight="black" style={{ color: '#2fe57d' }}>
                    {formatNumber(stats.following)}
                  </Text>
                  <Text size="xs" color="tertiary">关注</Text>
                </Box>
                <Box>
                  <Text size="lg" weight="black" style={{ color: '#4d9fff' }}>
                    {formatNumber(stats.posts)}
                  </Text>
                  <Text size="xs" color="tertiary">帖子</Text>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* 快捷操作按钮 */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            <Link href={`/u/${profile?.handle || userId}`} style={{ textDecoration: 'none' }}>
              <Button variant="ghost" size="sm">
                <UserIcon size={16} /> 我的主页
              </Button>
            </Link>
            <Link href="/settings" style={{ textDecoration: 'none' }}>
              <Button variant="ghost" size="sm">
                <SettingsIcon size={16} /> 设置
              </Button>
            </Link>
          </Box>
        </Box>

        {/* 主体两栏布局 */}
        <Box
          className="dashboard-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 340px',
            gap: tokens.spacing[6],
          }}
        >
          {/* 左栏：主要内容 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            {/* 快捷入口网格 */}
            <Box>
              <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
                快捷入口
              </Text>
              <Box style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: tokens.spacing[3],
              }}>
                {[
                  { label: '我的关注', href: '/following', icon: <UserIcon size={20} />, color: '#2fe57d' },
                  { label: '我的收藏', href: '/favorites', icon: <ChartIcon size={20} />, color: '#ff7c7c' },
                  { label: '我的帖子', href: '/my-posts', icon: <ChartIcon size={20} />, color: '#4d9fff' },
                  { label: '私信', href: '/messages', icon: <MessageIcon size={20} />, color: '#8b6fa8', badge: stats.unreadMessages },
                  { label: '通知', href: '/notifications', icon: <NotificationIcon size={20} />, color: '#ffc107', badge: stats.unreadNotifications },
                  { label: '搜索', href: '/search', icon: <SearchIcon size={20} />, color: '#9a9a9a' },
                ].map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    style={{
                      padding: tokens.spacing[4],
                      borderRadius: tokens.radius.lg,
                      background: tokens.colors.bg.secondary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      textDecoration: 'none',
                      color: 'inherit',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      transition: 'all 200ms ease',
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = `${item.color}15`
                      e.currentTarget.style.borderColor = item.color
                      e.currentTarget.style.transform = 'translateY(-2px)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                      e.currentTarget.style.borderColor = tokens.colors.border.primary
                      e.currentTarget.style.transform = 'translateY(0)'
                    }}
                  >
                    <Box style={{ color: item.color }}>{item.icon}</Box>
                    <Text size="sm" weight="bold">{item.label}</Text>
                    {item.badge && item.badge > 0 && (
                      <Box
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          minWidth: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: '#ff4d4d',
                          color: '#fff',
                          fontSize: 11,
                          fontWeight: 900,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 4px',
                        }}
                      >
                        {item.badge > 99 ? '99+' : item.badge}
                      </Box>
                    )}
                  </Link>
                ))}
              </Box>
            </Box>

            {/* 最近动态 */}
            <Box>
              <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
                最近动态
              </Text>
              {loadingActivities ? (
                <Box
                  bg="secondary"
                  p={8}
                  radius="lg"
                  border="primary"
                  style={{ textAlign: 'center' }}
                >
                  <Text color="secondary">加载中...</Text>
                </Box>
              ) : loadError ? (
                <Box
                  bg="secondary"
                  p={8}
                  radius="lg"
                  border="primary"
                  style={{ textAlign: 'center' }}
                >
                  <Text color="secondary" style={{ marginBottom: tokens.spacing[3] }}>{loadError}</Text>
                  <Button variant="primary" size="sm" onClick={handleRetry}>
                    重试
                  </Button>
                </Box>
              ) : activities.length === 0 ? (
                <EmptyState 
                  title="暂无动态"
                  description="你的活动记录会显示在这里"
                />
              ) : (
                <Box
                  bg="secondary"
                  radius="lg"
                  border="primary"
                  style={{ overflow: 'hidden' }}
                >
                  {activities.map((activity, index) => {
                    const style = getActivityStyle(activity.type)
                    return (
                      <Link
                        key={activity.id}
                        href={activity.href || '#'}
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: tokens.spacing[4],
                          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                          borderBottom: index < activities.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                          textDecoration: 'none',
                          color: 'inherit',
                          transition: 'background 0.2s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = tokens.colors.bg.tertiary
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent'
                        }}
                      >
                        <Box
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: tokens.radius.md,
                            background: style.bg,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 13,
                            fontWeight: 900,
                            color: style.color,
                            flexShrink: 0,
                          }}
                        >
                          {style.icon}
                        </Box>
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <Text size="sm" weight="bold" style={{ marginBottom: 2 }}>
                            {activity.title}
                          </Text>
                          {activity.description && (
                            <Text 
                              size="xs" 
                              color="secondary"
                              style={{
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {activity.description}
                            </Text>
                          )}
                          <Text size="xs" color="tertiary" style={{ marginTop: 4 }}>
                            {formatTimeAgo(activity.created_at)}
                          </Text>
                        </Box>
                      </Link>
                    )
                  })}
                </Box>
              )}
            </Box>
          </Box>

          {/* 右栏：统计和其他信息 */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
            {/* 数据统计卡片 */}
            <Box
              bg="secondary"
              p={5}
              radius="lg"
              border="primary"
            >
              <Text size="base" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
                数据概览
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {[
                  { label: '粉丝总数', value: stats.followers, color: '#8b6fa8', href: `/u/${profile?.handle || userId}` },
                  { label: '关注中', value: stats.following, color: '#2fe57d', href: '/following' },
                  { label: '发布帖子', value: stats.posts, color: '#4d9fff', href: '/my-posts' },
                  { label: '收藏内容', value: stats.favorites, color: '#ff7c7c', href: '/favorites' },
                ].map((stat) => (
                  <Link
                    key={stat.label}
                    href={stat.href}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.md,
                      background: tokens.colors.bg.primary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      textDecoration: 'none',
                      color: 'inherit',
                      transition: 'all 200ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = stat.color
                      e.currentTarget.style.background = `${stat.color}10`
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = tokens.colors.border.primary
                      e.currentTarget.style.background = tokens.colors.bg.primary
                    }}
                  >
                    <Text size="sm" color="secondary">{stat.label}</Text>
                    <Text size="lg" weight="black" style={{ color: stat.color }}>
                      {formatNumber(stat.value)}
                    </Text>
                  </Link>
                ))}
              </Box>
            </Box>

            {/* 未读消息提醒 */}
            {(stats.unreadMessages > 0 || stats.unreadNotifications > 0) && (
              <Box
                bg="secondary"
                p={5}
                radius="lg"
                border="primary"
              >
                <Text size="base" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
                  待处理
                </Text>
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                  {stats.unreadMessages > 0 && (
                    <Link
                      href="/messages"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: 'rgba(139,111,168,0.1)',
                        border: '1px solid rgba(139,111,168,0.3)',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <Box style={{ color: '#8b6fa8' }}>
                        <MessageIcon size={18} />
                      </Box>
                      <Text size="sm" weight="bold">
                        {stats.unreadMessages} 条未读私信
                      </Text>
                    </Link>
                  )}
                  {stats.unreadNotifications > 0 && (
                    <Link
                      href="/notifications"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: 'rgba(255,77,77,0.1)',
                        border: '1px solid rgba(255,77,77,0.3)',
                        textDecoration: 'none',
                        color: 'inherit',
                      }}
                    >
                      <Box style={{ color: '#ff4d4d' }}>
                        <NotificationIcon size={18} />
                      </Box>
                      <Text size="sm" weight="bold">
                        {stats.unreadNotifications} 条未读通知
                      </Text>
                    </Link>
                  )}
                </Box>
              </Box>
            )}

            {/* 快速发帖 */}
            <Box
              bg="secondary"
              p={5}
              radius="lg"
              border="primary"
            >
              <Text size="base" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
                快速操作
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <Link href="/groups" style={{ textDecoration: 'none' }}>
                  <Button variant="primary" fullWidth>
                    浏览小组
                  </Button>
                </Link>
                <Link href="/" style={{ textDecoration: 'none' }}>
                  <Button variant="secondary" fullWidth>
                    查看排行榜
                  </Button>
                </Link>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
