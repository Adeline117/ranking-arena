'use client'

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MarketPanel from '@/app/components/home/MarketPanel'
import Card from '@/app/components/ui/Card'
import RankingTableCompact from '@/app/components/ranking/RankingTableCompact'
import { Box, Text } from '@/app/components/base'
import { CommentIcon, ThumbsUpIcon } from '@/app/components/icons'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { getCsrfHeaders } from '@/lib/api/client'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
import { useUrlModal } from '@/lib/hooks/useUrlModal'
import { usePostStore, type PostData } from '@/lib/stores/postStore'
import PostDetailModal from '@/app/components/post/PostDetailModal'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const ARENA_PURPLE = '#8b6fa8'

function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ color: ARENA_PURPLE, textDecoration: 'underline', wordBreak: 'break-all' }}
        >
          {part}
        </a>
      )
    }
    return part
  })
}

type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}

function HotContent() {
  const { t, language } = useLanguage()
  const auth = useUnifiedAuth()
  const setPosts = usePostStore(s => s.setPosts)
  const storedPosts = usePostStore(s => s.posts)

  // Local UI state
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [hotPostIds, setHotPostIds] = useState<string[]>([])
  const [loadingPosts, setLoadingPosts] = useState(true)
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})

  // Translation state
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)

  // URL-driven modal for post detail
  const postModal = useUrlModal({
    paramName: 'post',
  })

  // Load trader data
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const response = await fetch('/api/traders?timeRange=90D')
        const json = await response.json()
        const tradersData = json.traders || json.data || []
        if (tradersData.length > 0) {
          interface TraderResponse {
            id?: string
            source_trader_id?: string
            handle?: string
            roi?: number
            pnl?: number
            win_rate?: number
            max_drawdown?: number
            followers?: number
            source?: string
          }
          const top10 = tradersData.slice(0, 10).map((item: TraderResponse) => ({
            id: item.id || item.source_trader_id || '',
            handle: item.handle || item.source_trader_id || null,
            roi: item.roi || 0,
            pnl: item.pnl || 0,
            win_rate: item.win_rate || 0,
            max_drawdown: item.max_drawdown,
            followers: item.followers || 0,
            source: item.source || 'binance',
          }))
          setTraders(top10)
        }
      } catch {
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  // Load hot posts from database and store in canonical store
  useEffect(() => {
    const loadPosts = async () => {
      setLoadingPosts(true)
      try {
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

        if (error || !data || data.length === 0) {
          setHotPostIds([])
          setLoadingPosts(false)
          return
        }

        // Convert to canonical PostData and store
        const postsData: PostData[] = data.map((post) => {
          const groupsData = post.groups as { name?: string } | { name?: string }[] | null
          const groupName = Array.isArray(groupsData) ? groupsData[0]?.name : groupsData?.name
          return {
            id: post.id,
            title: post.title || '无标题',
            content: post.content || '',
            author_handle: post.author_handle || '匿名',
            group_id: post.group_id,
            group_name: groupName || '综合讨论',
            created_at: post.created_at,
            like_count: post.like_count || 0,
            dislike_count: post.dislike_count || 0,
            comment_count: post.comment_count || 0,
            view_count: post.view_count || 0,
            hot_score: post.hot_score || 0,
          }
        })

        // Store in canonical store
        setPosts(postsData)
        // Keep ordered list of IDs for this page
        setHotPostIds(postsData.map(p => p.id))
      } catch {
        setHotPostIds([])
      } finally {
        setLoadingPosts(false)
      }
    }
    loadPosts()
  }, [setPosts])

  // Derive posts from store in hot-score order
  const hotPosts = useMemo(() => {
    return hotPostIds
      .map(id => storedPosts[id])
      .filter(Boolean) as PostData[]
  }, [hotPostIds, storedPosts])

  const visibleHot = useMemo(() => {
    return auth.isAuthenticated ? hotPosts : hotPosts.slice(0, 3)
  }, [auth.isAuthenticated, hotPosts])

  // Translation logic
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const matches = text.match(chineseRegex)
    return matches ? matches.length / text.length > 0.1 : false
  }, [])

  const translateListPosts = useCallback(async (postsToTranslate: PostData[], targetLang: 'zh' | 'en') => {
    if (translatingList) return
    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedListPosts[p.id]?.title) return false
      if (!p.title) return false
      const titleIsChinese = isChineseText(p.title)
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })
    if (needsTranslation.length === 0) return

    setTranslatingList(true)
    try {
      const items = needsTranslation.slice(0, 20).map(post => ({
        id: post.id,
        text: post.title || '',
        contentType: 'post_title' as const,
        contentId: post.id,
      }))
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string }>
        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = { title: result.translatedText }
          }
          return updated
        })
      }
    } catch { /* silent */ } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText])

  useEffect(() => {
    if (hotPosts.length > 0) {
      translateListPosts(hotPosts, language as 'zh' | 'en')
    }
  }, [hotPosts, language, translateListPosts])

  // Format time for display
  const formatPostTime = (createdAt: string) => {
    const now = new Date()
    const date = new Date(createdAt)
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays > 0) return `${diffDays}d`
    if (diffHours > 0) return `${diffHours}h`
    return `${Math.floor(diffMs / (1000 * 60))}m`
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={auth.email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="hot-grid" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
          {/* Left: Top 10 Traders */}
          <Box as="section">
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={auth.isAuthenticated} />
            </Card>
          </Box>

          {/* Center: Hot Posts */}
          <Box as="section">
            <Card title={t('hotList')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {auth.isAuthenticated ? t('loggedInShowAllHot') : t('notLoggedInShowLimitedHot')}
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
                    const isExpanded = expandedPosts[p.id]
                    const isLongContent = p.content.length > 100
                    const contentToShow = isExpanded || !isLongContent
                      ? p.content
                      : p.content.slice(0, 100) + '...'

                    return (
                      <Box
                        key={p.id}
                        className="hot-post-item"
                        bg="primary"
                        p={4}
                        radius="md"
                        border="primary"
                        style={{ cursor: 'pointer' }}
                        onClick={() => postModal.open(p.id)}
                        onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.primary }}
                      >
                        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
                          <Text size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                            #{rank}
                          </Text>
                          {/* Group name as link */}
                          {p.group_id ? (
                            <Link
                              href={`/groups/${p.group_id}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, textDecoration: 'none' }}
                            >
                              {p.group_name}
                            </Link>
                          ) : (
                            <Text size="xs" color="secondary">{p.group_name}</Text>
                          )}
                          <Text size="xs" color="tertiary">{(p.view_count ?? 0).toLocaleString()} {t('views')}</Text>
                        </Box>

                        <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                          {translatedListPosts[p.id]?.title || p.title}
                        </Text>

                        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
                          {renderContentWithLinks(contentToShow)}
                        </Text>
                        {isLongContent && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setExpandedPosts(prev => ({ ...prev, [p.id]: !prev[p.id] }))
                            }}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: ARENA_PURPLE,
                              cursor: 'pointer',
                              fontSize: 12,
                              marginBottom: tokens.spacing[2],
                              padding: 0,
                            }}
                          >
                            {isExpanded
                              ? (language === 'zh' ? '收起' : 'Show less')
                              : (language === 'zh' ? '展开查看' : 'Show more')}
                          </button>
                        )}

                        <Box style={{ display: 'flex', gap: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, flexWrap: 'wrap', alignItems: 'center' }}>
                          {/* Author as clickable link */}
                          <Link
                            href={`/u/${p.author_handle}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, textDecoration: 'none' }}
                          >
                            {p.author_handle}
                          </Link>
                          <Text size="xs" color="tertiary">{formatPostTime(p.created_at)}</Text>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CommentIcon size={12} /> {p.comment_count}
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <ThumbsUpIcon size={12} /> {p.like_count}
                          </span>
                        </Box>
                      </Box>
                    )
                  })}
                </Box>
              )}

              {!auth.isAuthenticated && hotPosts.length > 3 && (
                <Box style={{ marginTop: tokens.spacing[4], padding: tokens.spacing[3], textAlign: 'center' }}>
                  <Text size="sm" color="secondary">
                    {t('wantToSeeAllHotList')}
                    <Link href="/login" style={{ color: tokens.colors.accent.primary, textDecoration: 'none', marginLeft: tokens.spacing[1] }}>
                      {t('loginArrow')} &rarr;
                    </Link>
                  </Text>
                </Box>
              )}
            </Card>
          </Box>

          {/* Right: Market Panel */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* Post Detail Modal - URL-driven */}
      {postModal.isOpen && postModal.value && (
        <PostDetailModal
          postId={postModal.value}
          onClose={postModal.close}
        />
      )}
    </Box>
  )
}

export default function HotPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <HotContent />
    </Suspense>
  )
}
