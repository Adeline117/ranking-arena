'use client'

import { useEffect, useState, Suspense, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import EmptyState from '@/app/components/ui/EmptyState'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'

type SearchResult = {
  type: 'trader' | 'post' | 'group' | 'user'
  id: string
  title: string
  subtitle?: string
  meta?: string
  uid?: number // 用户数字编号
}

// 高亮样式 - 使用 CSS 变量实现主题一致性
const HIGHLIGHT_STYLE = {
  backgroundColor: 'rgba(139, 111, 168, 0.4)',
  color: '#d4b8e8',
  borderRadius: '4px',
  padding: '1px 4px',
  fontWeight: 600,
}

type TabType = 'all' | 'users' | 'traders' | 'posts' | 'groups'
const VALID_TABS: TabType[] = ['all', 'users', 'traders', 'posts', 'groups']

const PAGE_SIZE = 10

function SearchContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { t } = useLanguage()
  const query = searchParams.get('q') || ''
  const tabParam = searchParams.get('tab') as TabType | null
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const activeTab: TabType = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'all'
  const [searchError, setSearchError] = useState(false)
  const { showToast } = useToast()
  const [offsets, setOffsets] = useState<Record<string, number>>({ users: PAGE_SIZE, traders: PAGE_SIZE, posts: PAGE_SIZE, groups: PAGE_SIZE })
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({ users: true, traders: true, posts: true, groups: true })
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({ users: false, traders: false, posts: false, groups: false })

  const setActiveTab = useCallback((tab: TabType) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'all') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    router.replace(`/search?${params.toString()}`, { scroll: false })
  }, [searchParams, router])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  // 高亮匹配文本的函数
  const highlightText = useCallback((text: string, searchQuery: string): React.ReactNode => {
    if (!text || !searchQuery.trim()) return text

    const lowerText = text.toLowerCase()
    const lowerQuery = searchQuery.toLowerCase().trim()
    const parts: React.ReactNode[] = []
    let lastIndex = 0

    // 找到所有匹配项
    let index = lowerText.indexOf(lowerQuery)
    while (index !== -1) {
      // 添加匹配前的文本
      if (index > lastIndex) {
        parts.push(text.slice(lastIndex, index))
      }
      // 添加高亮的匹配文本
      parts.push(
        <span key={`highlight-${index}`} style={HIGHLIGHT_STYLE}>
          {text.slice(index, index + lowerQuery.length)}
        </span>
      )
      lastIndex = index + lowerQuery.length
      index = lowerText.indexOf(lowerQuery, lastIndex)
    }
    
    // 添加剩余文本
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex))
    }

    return parts.length > 0 ? parts : text
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    // Reset pagination state on new query
    setOffsets({ users: PAGE_SIZE, traders: PAGE_SIZE, posts: PAGE_SIZE, groups: PAGE_SIZE })
    setHasMore({ users: true, traders: true, posts: true, groups: true })

    const search = async () => {
      setLoading(true)
      setSearchError(false)
      const results: SearchResult[] = []

      // 转义 LIKE 通配符防止注入
      const sanitizedQuery = query.trim()
        .slice(0, 100)
        .replace(/[\\%_]/g, c => `\\${c}`)

      if (!sanitizedQuery) {
        setLoading(false)
        return
      }

      try {
        const isNumericQuery = /^\d+$/.test(query.trim())

        // 并行查询所有数据源（使用 allSettled 避免单个失败丢失全部结果）
        // Fetch PAGE_SIZE + 1 to detect if more results exist
        const settled = await Promise.allSettled([
          // 搜索用户
          isNumericQuery
            ? supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').eq('uid', parseInt(query.trim())).limit(PAGE_SIZE + 1)
            : supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').ilike('handle', `%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          // 搜索交易者
          supabase.from('trader_sources').select('source_trader_id, handle, source').or(`handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          // 搜索帖子
          supabase.from('posts').select('id, title, content, author_handle, created_at').or(`title.ilike.%${sanitizedQuery}%,content.ilike.%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          // 搜索小组
          supabase.from('groups').select('id, name').ilike('name', `%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
        ])
        const usersData = settled[0].status === 'fulfilled' ? settled[0].value : { data: null }
        const tradersData = settled[1].status === 'fulfilled' ? settled[1].value : { data: null }
        const postsData = settled[2].status === 'fulfilled' ? settled[2].value : { data: null }
        const groupsData = settled[3].status === 'fulfilled' ? settled[3].value : { data: null }

        // Detect hasMore for each category
        const newHasMore = {
          users: (usersData.data?.length ?? 0) > PAGE_SIZE,
          traders: (tradersData.data?.length ?? 0) > PAGE_SIZE,
          posts: (postsData.data?.length ?? 0) > PAGE_SIZE,
          groups: (groupsData.data?.length ?? 0) > PAGE_SIZE,
        }
        setHasMore(newHasMore)

        // 处理用户结果
        if (usersData.data) {
          const users = usersData.data.slice(0, PAGE_SIZE)
          users.forEach((u: Record<string, unknown>) => {
            results.push({
              type: 'user',
              id: u.id as string,
              title: (u.handle as string) || t('noHandle'),
              subtitle: ((u.bio as string) || '').substring(0, 80),
              meta: u.uid ? `UID: ${u.uid}` : undefined,
              uid: u.uid as number | undefined,
            })
          })
        }

        // 处理交易员结果 - 批量获取快照数据
        const traders = tradersData.data?.slice(0, PAGE_SIZE) ?? null
        if (traders && traders.length > 0) {
          const traderKeys = traders.map(t => t.source_trader_id)
          const { data: allSnapshots } = await supabase
            .from('trader_snapshots')
            .select('source_trader_id, season_id, roi, arena_score, captured_at')
            .in('source_trader_id', traderKeys)
            .not('arena_score', 'is', null)
            .order('captured_at', { ascending: false })

          // 构建映射（优先 90D > 30D > 7D）
          const snapshotMap = new Map<string, { season_id: string; roi: number; arena_score: number }>()
          const windowPriority: Record<string, number> = { '90D': 3, '30D': 2, '7D': 1 }

          allSnapshots?.forEach((s: Record<string, unknown>) => {
            const key = s.source_trader_id as string
            const existing = snapshotMap.get(key)
            const currentP = windowPriority[s.season_id as string] || 0
            const existingP = existing ? (windowPriority[existing.season_id] || 0) : 0
            if (!existing || currentP > existingP) {
              const roi = typeof s.roi === 'string' ? parseFloat(s.roi) : (s.roi as number)
              const arenaScore = typeof s.arena_score === 'string' ? parseFloat(s.arena_score) : (s.arena_score as number)
              snapshotMap.set(key, { season_id: s.season_id as string, roi, arena_score: arenaScore })
            }
          })

          for (const trader of traders) {
            const latest = snapshotMap.get(trader.source_trader_id)
            const platformLabel = (trader.source || '').replace(/_/g, ' ').toUpperCase()
            const subtitle = latest
              ? `${latest.season_id}: ROI ${latest.roi?.toFixed(1)}% • Score ${latest.arena_score?.toFixed(1)}`
              : platformLabel
            results.push({
              type: 'trader',
              id: trader.source_trader_id,
              title: trader.handle || trader.source_trader_id,
              subtitle,
              meta: platformLabel || undefined,
            })
          }
        }

        // 处理帖子结果
        if (postsData.data) {
          const posts = postsData.data.slice(0, PAGE_SIZE)
          posts.forEach((p: Record<string, unknown>) => {
            results.push({
              type: 'post',
              id: p.id as string,
              title: (p.title as string) || '',
              subtitle: ((p.content as string) || '').substring(0, 100),
              meta: `${t('byAuthor')}: ${(p.author_handle as string) || t('unknown')}`,
            })
          })
        }

        // 处理小组结果
        if (groupsData.data) {
          const groups = groupsData.data.slice(0, PAGE_SIZE)
          groups.forEach((g: Record<string, unknown>) => {
            results.push({
              type: 'group',
              id: g.id as string,
              title: (g.name as string) || '',
              subtitle: '',
            })
          })
        }

        setResults(results)
        setSearchError(false)
      } catch (error: unknown) {
        console.error('Search error:', error)
        setSearchError(true)
        showToast(t('searchFailed'), 'error')
      } finally {
        setLoading(false)
      }
    }

    const timeout = setTimeout(search, 300)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, t])

  const loadMore = useCallback(async (type: 'users' | 'traders' | 'posts' | 'groups') => {
    if (!query.trim() || loadingMore[type] || !hasMore[type]) return

    setLoadingMore(prev => ({ ...prev, [type]: true }))

    const sanitizedQuery = query.trim()
      .slice(0, 100)
      .replace(/[\\%_]/g, c => `\\${c}`)

    const offset = offsets[type]
    const isNumericQuery = /^\d+$/.test(query.trim())

    try {
      const newResults: SearchResult[] = []

      if (type === 'users') {
        const { data } = isNumericQuery
          ? await supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').eq('uid', parseInt(query.trim())).range(offset, offset + PAGE_SIZE)
          : await supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').ilike('handle', `%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE)
        if (data) {
          if (data.length <= PAGE_SIZE) {
            setHasMore(prev => ({ ...prev, users: false }))
          }
          data.slice(0, PAGE_SIZE).forEach((u: Record<string, unknown>) => {
            newResults.push({
              type: 'user',
              id: u.id as string,
              title: (u.handle as string) || t('noHandle'),
              subtitle: ((u.bio as string) || '').substring(0, 80),
              meta: u.uid ? `UID: ${u.uid}` : undefined,
              uid: u.uid as number | undefined,
            })
          })
        }
      } else if (type === 'traders') {
        const { data } = await supabase.from('trader_sources').select('source_trader_id, handle, source').or(`handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE)
        if (data) {
          if (data.length <= PAGE_SIZE) {
            setHasMore(prev => ({ ...prev, traders: false }))
          }
          const traders = data.slice(0, PAGE_SIZE)
          if (traders.length > 0) {
            const traderKeys = traders.map(t => t.source_trader_id)
            const { data: allSnapshots } = await supabase
              .from('trader_snapshots')
              .select('source_trader_id, season_id, roi, arena_score, captured_at')
              .in('source_trader_id', traderKeys)
              .not('arena_score', 'is', null)
              .order('captured_at', { ascending: false })

            const snapshotMap = new Map<string, { season_id: string; roi: number; arena_score: number }>()
            const windowPriority: Record<string, number> = { '90D': 3, '30D': 2, '7D': 1 }
            allSnapshots?.forEach((s: Record<string, unknown>) => {
              const key = s.source_trader_id as string
              const existing = snapshotMap.get(key)
              const currentP = windowPriority[s.season_id as string] || 0
              const existingP = existing ? (windowPriority[existing.season_id] || 0) : 0
              if (!existing || currentP > existingP) {
                const roi = typeof s.roi === 'string' ? parseFloat(s.roi) : (s.roi as number)
                const arenaScore = typeof s.arena_score === 'string' ? parseFloat(s.arena_score) : (s.arena_score as number)
                snapshotMap.set(key, { season_id: s.season_id as string, roi, arena_score: arenaScore })
              }
            })

            for (const trader of traders) {
              const latest = snapshotMap.get(trader.source_trader_id)
              const platformLabel = (trader.source || '').replace(/_/g, ' ').toUpperCase()
              const subtitle = latest
                ? `${latest.season_id}: ROI ${latest.roi?.toFixed(1)}% • Score ${latest.arena_score?.toFixed(1)}`
                : platformLabel
              newResults.push({
                type: 'trader',
                id: trader.source_trader_id,
                title: trader.handle || trader.source_trader_id,
                subtitle,
                meta: platformLabel || undefined,
              })
            }
          }
        }
      } else if (type === 'posts') {
        const { data } = await supabase.from('posts').select('id, title, content, author_handle, created_at').or(`title.ilike.%${sanitizedQuery}%,content.ilike.%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE)
        if (data) {
          if (data.length <= PAGE_SIZE) {
            setHasMore(prev => ({ ...prev, posts: false }))
          }
          data.slice(0, PAGE_SIZE).forEach((p: Record<string, unknown>) => {
            newResults.push({
              type: 'post',
              id: p.id as string,
              title: (p.title as string) || '',
              subtitle: ((p.content as string) || '').substring(0, 100),
              meta: `${t('byAuthor')}: ${(p.author_handle as string) || t('unknown')}`,
            })
          })
        }
      } else if (type === 'groups') {
        const { data } = await supabase.from('groups').select('id, name').ilike('name', `%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE)
        if (data) {
          if (data.length <= PAGE_SIZE) {
            setHasMore(prev => ({ ...prev, groups: false }))
          }
          data.slice(0, PAGE_SIZE).forEach((g: Record<string, unknown>) => {
            newResults.push({
              type: 'group',
              id: g.id as string,
              title: (g.name as string) || '',
              subtitle: '',
            })
          })
        }
      }

      if (newResults.length > 0) {
        setResults(prev => [...prev, ...newResults])
        setOffsets(prev => ({ ...prev, [type]: offset + PAGE_SIZE }))
      } else {
        setHasMore(prev => ({ ...prev, [type]: false }))
      }
    } catch (error: unknown) {
      console.error(`Load more ${type} error:`, error)
      showToast(t('loadMoreFailed'), 'error')
    } finally {
      setLoadingMore(prev => ({ ...prev, [type]: false }))
    }
  }, [query, offsets, hasMore, loadingMore, showToast, t])

  const TAB_TYPE_MAP: Record<TabType, SearchResult['type'] | null> = {
    all: null,
    users: 'user',
    traders: 'trader',
    posts: 'post',
    groups: 'group',
  }

  const filterType = TAB_TYPE_MAP[activeTab]
  const filteredResults = filterType
    ? results.filter(r => r.type === filterType)
    : results

  const getHref = (result: SearchResult) => {
    if (result.type === 'user') return `/u/${encodeURIComponent(result.title)}`
    if (result.type === 'trader') return `/trader/${encodeURIComponent(result.id)}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    return '#'
  }

  const getIcon = (type: string): string => {
    switch (type) {
      case 'user': return 'U'
      case 'trader': return 'T'
      case 'post': return 'P'
      case 'group': return 'G'
      default: return 'S'
    }
  }

  const getBadgeBackground = (type: string): string => {
    switch (type) {
      case 'user': return 'linear-gradient(135deg, rgba(139, 111, 168, 0.2), rgba(139, 111, 168, 0.1))'
      case 'trader': return tokens.gradient.successSubtle
      case 'post': return tokens.gradient.primarySubtle
      default: return tokens.gradient.warningSubtle
    }
  }

  const getBadgeColor = (type: string): string => {
    switch (type) {
      case 'user': return '#8b6fa8'
      case 'trader': return tokens.colors.accent.success
      case 'post': return tokens.colors.accent.primary
      default: return tokens.colors.accent.warning
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary, position: 'relative' }}>
      {/* Background mesh */}
      <div 
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.gradient.mesh,
          opacity: 0.5,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      
      <TopNav email={email} />
      
      <main className="page-enter" style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px', paddingBottom: 100, position: 'relative', zIndex: 1 }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 className="search-title gradient-text" style={{ fontSize: '28px', fontWeight: 950, marginBottom: '8px' }}>
            {t('searchResults')}
          </h1>
          <div style={{ fontSize: '14px', color: tokens.colors.text.tertiary }}>
            {query ? `${t('search')}: "${query}"` : t('enterSearchTerm')}
          </div>
        </div>

        {query && (
          <div className="search-tabs" style={{ 
            display: 'flex', 
            gap: '8px', 
            marginBottom: '20px',
            paddingBottom: '12px',
          }}>
            {(['all', 'users', 'traders', 'posts', 'groups'] as const).map((tab) => (
              <button
                key={tab}
                className="search-tab-button btn-press"
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '10px 20px',
                  borderRadius: tokens.radius.lg,
                  border: activeTab === tab ? 'none' : tokens.glass.border.light,
                  background: activeTab === tab ? tokens.gradient.primary : tokens.glass.bg.light,
                  backdropFilter: tokens.glass.blur.sm,
                  WebkitBackdropFilter: tokens.glass.blur.sm,
                  color: activeTab === tab ? '#fff' : tokens.colors.text.secondary,
                  fontWeight: activeTab === tab ? 900 : 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: tokens.transition.all,
                  boxShadow: activeTab === tab ? `0 4px 12px ${tokens.colors.accent.primary}40` : 'none',
                }}
                onMouseEnter={(e) => {
                  if (activeTab !== tab) {
                    e.currentTarget.style.background = tokens.glass.bg.medium
                    e.currentTarget.style.color = tokens.colors.text.primary
                  }
                }}
                onMouseLeave={(e) => {
                  if (activeTab !== tab) {
                    e.currentTarget.style.background = tokens.glass.bg.light
                    e.currentTarget.style.color = tokens.colors.text.secondary
                  }
                }}
              >
                {{ all: t('all'), users: t('users'), traders: t('traders'), posts: t('posts'), groups: t('groups') }[tab]}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  padding: '20px',
                  borderRadius: tokens.radius.xl,
                  background: tokens.glass.bg.secondary,
                  border: tokens.glass.border.light,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: tokens.radius.lg,
                    background: tokens.colors.bg.tertiary,
                    animation: 'pulse 1.5s ease-in-out infinite',
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      width: `${50 + i * 8}%`,
                      height: 16,
                      borderRadius: tokens.radius.sm,
                      background: tokens.colors.bg.tertiary,
                      marginBottom: 8,
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                    <div style={{
                      width: `${30 + i * 5}%`,
                      height: 12,
                      borderRadius: tokens.radius.sm,
                      background: tokens.colors.bg.tertiary,
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : searchError ? (
          <EmptyState
            title={t('searchFailedTitle')}
            description={t('pleaseTryAgainLater')}
          />
        ) : !query ? (
          <EmptyState
            title={t('startSearching')}
            description={t('startSearchingDesc')}
          />
        ) : filteredResults.length === 0 ? (
          <EmptyState
            title={t('noResults')}
            description={t('noResultsForQuery').replace('{query}', query)}
          />
        ) : (
          <div className="stagger-children search-results" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {filteredResults.map((result) => (
              <Link
                key={`${result.type}-${result.id}`}
                href={getHref(result)}
                className="search-result-item search-result-card glass-card-hover list-item-indicator"
                style={{
                  display: 'block',
                  padding: '20px',
                  borderRadius: tokens.radius.xl,
                  background: tokens.glass.bg.secondary,
                  backdropFilter: tokens.glass.blur.md,
                  WebkitBackdropFilter: tokens.glass.blur.md,
                  border: tokens.glass.border.light,
                  textDecoration: 'none',
                  color: 'inherit',
                  transition: tokens.transition.all,
                  position: 'relative',
                  overflow: 'hidden',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.glass.bg.tertiary
                  e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}30`
                  e.currentTarget.style.boxShadow = tokens.shadow.lg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = tokens.glass.bg.secondary
                  e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  {/* Type Icon Badge */}
                  <div style={{ 
                    width: 44,
                    height: 44,
                    borderRadius: tokens.radius.lg,
                    background: getBadgeBackground(result.type),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px',
                    fontWeight: 900,
                    color: getBadgeColor(result.type),
                    flexShrink: 0,
                  }}>
                    {getIcon(result.type)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="search-result-title" style={{ 
                      fontSize: '16px', 
                      fontWeight: 800, 
                      marginBottom: '6px', 
                      color: tokens.colors.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {highlightText(result.title, query)}
                    </div>
                    {result.subtitle && (
                      <div className="search-result-subtitle" style={{ 
                        fontSize: '13px', 
                        color: tokens.colors.text.secondary, 
                        marginBottom: '6px',
                        lineHeight: 1.5,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}>
                        {highlightText(result.subtitle, query)}
                      </div>
                    )}
                    {result.meta && (
                      <div className="search-result-meta" style={{ fontSize: '12px', color: tokens.colors.text.tertiary }}>
                        {result.meta}
                      </div>
                    )}
                  </div>
                  {/* Arrow indicator */}
                  <div style={{ 
                    color: tokens.colors.text.tertiary,
                    opacity: 0.5,
                    transition: tokens.transition.base,
                  }}>
                    →
                  </div>
                </div>
              </Link>
            ))}

            {/* Load More button for the active tab */}
            {activeTab !== 'all' && hasMore[activeTab] && (
              <button
                onClick={() => loadMore(activeTab as 'users' | 'traders' | 'posts' | 'groups')}
                disabled={loadingMore[activeTab]}
                className="btn-press"
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  marginTop: '8px',
                  borderRadius: tokens.radius.lg,
                  border: tokens.glass.border.light,
                  background: tokens.glass.bg.light,
                  backdropFilter: tokens.glass.blur.sm,
                  WebkitBackdropFilter: tokens.glass.blur.sm,
                  color: tokens.colors.text.secondary,
                  fontWeight: 700,
                  fontSize: '14px',
                  cursor: loadingMore[activeTab] ? 'not-allowed' : 'pointer',
                  transition: tokens.transition.all,
                  opacity: loadingMore[activeTab] ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!loadingMore[activeTab]) {
                    e.currentTarget.style.background = tokens.glass.bg.medium
                    e.currentTarget.style.color = tokens.colors.text.primary
                  }
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = tokens.glass.bg.light
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }}
              >
                {loadingMore[activeTab] ? t('loading') : t('loadMore')}
              </button>
            )}

            {/* Load More buttons for "all" tab - show per category */}
            {activeTab === 'all' && (
              <>
                {(['users', 'traders', 'posts', 'groups'] as const).map((type) => {
                  const typeResults = results.filter(r => {
                    if (type === 'users') return r.type === 'user'
                    if (type === 'traders') return r.type === 'trader'
                    if (type === 'posts') return r.type === 'post'
                    if (type === 'groups') return r.type === 'group'
                    return false
                  })
                  if (typeResults.length === 0 || !hasMore[type]) return null
                  const typeLabel = type === 'users' ? t('users').toLowerCase() : type === 'traders' ? t('traders').toLowerCase() : type === 'posts' ? t('posts').toLowerCase() : t('groups').toLowerCase()
                  return (
                    <button
                      key={type}
                      onClick={() => loadMore(type)}
                      disabled={loadingMore[type]}
                      className="btn-press"
                      style={{
                        width: '100%',
                        padding: '14px 24px',
                        marginTop: '8px',
                        borderRadius: tokens.radius.lg,
                        border: tokens.glass.border.light,
                        background: tokens.glass.bg.light,
                        backdropFilter: tokens.glass.blur.sm,
                        WebkitBackdropFilter: tokens.glass.blur.sm,
                        color: tokens.colors.text.secondary,
                        fontWeight: 700,
                        fontSize: '14px',
                        cursor: loadingMore[type] ? 'not-allowed' : 'pointer',
                        transition: tokens.transition.all,
                        opacity: loadingMore[type] ? 0.6 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!loadingMore[type]) {
                          e.currentTarget.style.background = tokens.glass.bg.medium
                          e.currentTarget.style.color = tokens.colors.text.primary
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = tokens.glass.bg.light
                        e.currentTarget.style.color = tokens.colors.text.secondary
                      }}
                    >
                      {loadingMore[type] ? t('loading') : t('loadMoreType').replace('{type}', typeLabel)}
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={null} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: 60 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                style={{
                  padding: '20px',
                  borderRadius: '16px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: '12px',
                    background: 'rgba(255,255,255,0.06)',
                    animation: 'pulse 1.5s ease-in-out infinite',
                    flexShrink: 0,
                  }} />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      width: `${50 + i * 8}%`,
                      height: 16,
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.06)',
                      marginBottom: 8,
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                    <div style={{
                      width: `${30 + i * 5}%`,
                      height: 12,
                      borderRadius: '6px',
                      background: 'rgba(255,255,255,0.06)',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}

