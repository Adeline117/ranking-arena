'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import MarketPanel from '@/app/components/Features/MarketPanel'
import Card from '@/app/components/UI/Card'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import { Box, Text } from '@/app/components/Base'
// 本地 Trader 类型，匹配 RankingTableCompact 的期望
type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

type Post = {
  id: string
  group: string
  title: string
  author: string
  author_handle?: string
  time: string
  body: string
  comments: number
  likes: number
  hotScore: number
  views: number
}

export default function HotPage() {
  const { t } = useLanguage()
  const [loggedIn, setLoggedIn] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [posts, setPosts] = useState<Post[]>([])
  const [loadingPosts, setLoadingPosts] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
    })
  }, [])

  // 加载交易员数据
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      
      // 获取最新的 captured_at
      const { data: latestSnapshot } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', 'binance')
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (!latestSnapshot) {
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询 snapshots
      const { data: snapshots } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, rank, roi, followers')
        .eq('source', 'binance')
        .eq('captured_at', latestSnapshot.captured_at)
        .order('rank', { ascending: true })
        .limit(10)

      if (!snapshots || snapshots.length === 0) {
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询 handles
      const traderIds = snapshots.map((s: any) => s.source_trader_id)
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle')
        .eq('source', 'binance')
        .in('source_trader_id', traderIds)

      const handleMap = new Map()
      if (sources) {
        sources.forEach((s: any) => {
          handleMap.set(s.source_trader_id, s.handle)
        })
      }

      const tradersData = snapshots.map((item: any) => ({
        id: item.source_trader_id,
        handle: handleMap.get(item.source_trader_id) || item.source_trader_id,
        roi: item.roi || 0,
        win_rate: 0,
        followers: item.followers || 0,
        source: 'binance' as const,
      }))
      
      setTraders(tradersData as Trader[])

      setLoadingTraders(false)
    }
    load()
  }, [])

  // 从数据库加载热榜帖子
  useEffect(() => {
    const loadPosts = async () => {
      setLoadingPosts(true)
      try {
        // 从数据库获取热门帖子
        const { data, error } = await supabase
          .from('posts')
          .select(`
            id,
            title,
            content,
            author_handle,
            created_at,
            like_count,
            dislike_count,
            comment_count,
            view_count,
            hot_score,
            group_id,
            groups(name)
          `)
          .order('hot_score', { ascending: false, nullsFirst: false })
          .order('view_count', { ascending: false, nullsFirst: false })
          .order('like_count', { ascending: false, nullsFirst: false })
          .limit(20)

        if (error) {
          console.error('Failed to load hot posts:', error)
          setPosts([])
          setLoadingPosts(false)
          return
        }

        if (data && data.length > 0) {
          const postsData: Post[] = data.map((post: any) => {
            // 计算时间差
            const createdAt = new Date(post.created_at)
            const now = new Date()
            const diffMs = now.getTime() - createdAt.getTime()
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
            const diffDays = Math.floor(diffHours / 24)
            
            let timeStr = ''
            if (diffDays > 0) {
              timeStr = `${diffDays}d`
            } else if (diffHours > 0) {
              timeStr = `${diffHours}h`
            } else {
              const diffMins = Math.floor(diffMs / (1000 * 60))
              timeStr = `${diffMins}m`
            }

            return {
              id: post.id,
              group: post.groups?.name || '综合讨论',
              title: post.title || '无标题',
              author: post.author_handle || '匿名',
              author_handle: post.author_handle,
              time: timeStr,
              body: post.content || '',
              comments: post.comment_count || 0,
              likes: post.like_count || 0,
              hotScore: post.hot_score || 
                (post.view_count || 0) * 0.1 + 
                (post.like_count || 0) * 2 + 
                (post.comment_count || 0) * 3,
              views: post.view_count || 0,
            }
          })
          setPosts(postsData)
        } else {
          setPosts([])
        }
      } catch (e) {
        console.error('Failed to load posts:', e)
        setPosts([])
      } finally {
        setLoadingPosts(false)
      }
    }
    
    loadPosts()
  }, [])

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  const visibleHot = useMemo(() => {
    return loggedIn ? hotPosts : hotPosts.slice(0, 3) // 未登录只显示前3条
  }, [loggedIn, hotPosts])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="hot-grid" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
          {/* 左：排名前十 */}
          <Box as="section">
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：热榜 */}
          <Box as="section">
            <Card title={t('hotList')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? t('loggedInShowAllHot') : t('notLoggedInShowLimitedHot')}
              </Text>
              
              {loadingPosts ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  <Text color="tertiary">{t('loading')}</Text>
                </Box>
              ) : visibleHot.length === 0 ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  <Text color="tertiary">{t('noData')}</Text>
                </Box>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  {visibleHot.map((p, idx) => {
                    const rank = idx + 1
                    return (
                      <Link
                        key={p.id}
                        href={`/groups?post=${p.id}`}
                        style={{ textDecoration: 'none' }}
                      >
                        <Box
                          className="hot-post-item"
                          bg="primary"
                          p={4}
                          radius="md"
                          border="primary"
                          style={{
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.secondary
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.primary
                          }}
                        >
                          <Box className="hot-post-meta" style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
                            <Text className="hot-post-rank" size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                              #{rank}
                            </Text>
                            <Text size="xs" color="secondary">{p.group}</Text>
                            <Text size="xs" color="tertiary">{(p.views ?? 0).toLocaleString()} {t('views')}</Text>
                          </Box>
                          <Text className="hot-post-title" size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                            {p.title}
                          </Text>
                          <Text className="hot-post-body" size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
                            {p.body.slice(0, 100)}{p.body.length > 100 ? '...' : ''}
                          </Text>
                          <Box className="hot-post-footer" style={{ display: 'flex', gap: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, flexWrap: 'wrap' }}>
                            <Text size="xs" color="tertiary">{p.author}</Text>
                            <Text size="xs" color="tertiary">{p.time}</Text>
                            <Text size="xs" color="tertiary">💬 {p.comments}</Text>
                            <Text size="xs" color="tertiary">👍 {p.likes}</Text>
                          </Box>
                        </Box>
                      </Link>
                    )
                  })}
                </Box>
              )}
              
              {!loggedIn && posts.length > 3 && (
                <Box style={{ marginTop: tokens.spacing[4], padding: tokens.spacing[3], textAlign: 'center' }}>
                  <Text size="sm" color="secondary">
                    {t('wantToSeeAllHotList')}
                    <Link href="/login" style={{ color: tokens.colors.accent.primary, textDecoration: 'none', marginLeft: tokens.spacing[1] }}>
                      {t('loginArrow')} →
                    </Link>
                  </Text>
                </Box>
              )}
            </Card>
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
