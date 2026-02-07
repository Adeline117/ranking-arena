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
import { TraderSearchFilter, type TraderFilterConfig } from '@/app/components/search/TraderSearchFilter'

type SearchResult = {
  type: 'trader' | 'post' | 'group' | 'user'
  id: string
  title: string
  subtitle?: string
  meta?: string
  uid?: number
}

const HIGHLIGHT_STYLE = {
  backgroundColor: 'rgba(139, 111, 168, 0.25)',
  color: 'inherit',
  borderRadius: '2px',
  padding: '0 2px',
  fontWeight: 600 as const,
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

  const [traderFilter, setTraderFilter] = useState<TraderFilterConfig>({})
  const [isFilterVisible, setIsFilterVisible] = useState(false)

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

  const highlightText = useCallback((text: string, searchQuery: string): React.ReactNode => {
    if (!text || !searchQuery.trim()) return text
    const lowerText = text.toLowerCase()
    const lowerQuery = searchQuery.toLowerCase().trim()
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    let index = lowerText.indexOf(lowerQuery)
    while (index !== -1) {
      if (index > lastIndex) parts.push(text.slice(lastIndex, index))
      parts.push(
        <span key={`hl-${index}`} style={HIGHLIGHT_STYLE}>
          {text.slice(index, index + lowerQuery.length)}
        </span>
      )
      lastIndex = index + lowerQuery.length
      index = lowerText.indexOf(lowerQuery, lastIndex)
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length > 0 ? parts : text
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    setOffsets({ users: PAGE_SIZE, traders: PAGE_SIZE, posts: PAGE_SIZE, groups: PAGE_SIZE })
    setHasMore({ users: true, traders: true, posts: true, groups: true })

    const search = async () => {
      setLoading(true)
      setSearchError(false)
      const results: SearchResult[] = []

      const sanitizedQuery = query.trim()
        .slice(0, 100)
        .replace(/[\\%_]/g, c => `\\${c}`)

      if (!sanitizedQuery) {
        setLoading(false)
        return
      }

      try {
        const isNumericQuery = /^\d+$/.test(query.trim())

        const settled = await Promise.allSettled([
          isNumericQuery
            ? supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').eq('uid', parseInt(query.trim())).limit(PAGE_SIZE + 1)
            : supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').ilike('handle', `%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          supabase.from('trader_sources').select('source_trader_id, handle, source').or(`handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          supabase.from('posts').select('id, title, content, author_handle, created_at').or(`title.ilike.%${sanitizedQuery}%,content.ilike.%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
          supabase.from('groups').select('id, name').ilike('name', `%${sanitizedQuery}%`).limit(PAGE_SIZE + 1),
        ])
        const usersData = settled[0].status === 'fulfilled' ? settled[0].value : { data: null }
        const tradersData = settled[1].status === 'fulfilled' ? settled[1].value : { data: null }
        const postsData = settled[2].status === 'fulfilled' ? settled[2].value : { data: null }
        const groupsData = settled[3].status === 'fulfilled' ? settled[3].value : { data: null }

        const newHasMore = {
          users: (usersData.data?.length ?? 0) > PAGE_SIZE,
          traders: (tradersData.data?.length ?? 0) > PAGE_SIZE,
          posts: (postsData.data?.length ?? 0) > PAGE_SIZE,
          groups: (groupsData.data?.length ?? 0) > PAGE_SIZE,
        }
        setHasMore(newHasMore)

        if (usersData.data) {
          usersData.data.slice(0, PAGE_SIZE).forEach((u: Record<string, unknown>) => {
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

        let traders = tradersData.data?.slice(0, PAGE_SIZE * 2) ?? null

        if (traders && traderFilter.exchange?.length) {
          traders = traders.filter(t =>
            traderFilter.exchange!.some(ex =>
              (t.source || '').toLowerCase().includes(ex.toLowerCase())
            )
          )
        }

        if (traders && traders.length > 0) {
          const traderKeys = traders.map(t => t.source_trader_id)

          let snapshotQuery = supabase
            .from('trader_snapshots')
            .select('source_trader_id, season_id, roi, arena_score, captured_at')
            .in('source_trader_id', traderKeys)
            .not('arena_score', 'is', null)

          if (traderFilter.period) {
            snapshotQuery = snapshotQuery.eq('season_id', traderFilter.period)
          }

          const { data: allSnapshots } = await snapshotQuery.order('captured_at', { ascending: false })

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

            if (latest) {
              if (traderFilter.roi_min != null && latest.roi < traderFilter.roi_min) continue
              if (traderFilter.roi_max != null && latest.roi > traderFilter.roi_max) continue
              if (traderFilter.min_score != null && latest.arena_score < traderFilter.min_score) continue
            } else if (traderFilter.roi_min != null || traderFilter.roi_max != null || traderFilter.min_score != null) {
              continue
            }

            const platformLabel = (trader.source || '').replace(/_/g, ' ').toUpperCase()
            const subtitle = latest
              ? `${latest.season_id}: ROI ${latest.roi?.toFixed(1)}% | Score ${latest.arena_score?.toFixed(1)}`
              : platformLabel
            results.push({
              type: 'trader',
              id: trader.source_trader_id,
              title: trader.handle || trader.source_trader_id,
              subtitle,
              meta: platformLabel || undefined,
            })

            if (results.filter(r => r.type === 'trader').length >= PAGE_SIZE) break
          }
        }

        if (postsData.data) {
          postsData.data.slice(0, PAGE_SIZE).forEach((p: Record<string, unknown>) => {
            results.push({
              type: 'post',
              id: p.id as string,
              title: (p.title as string) || '',
              subtitle: ((p.content as string) || '').substring(0, 100),
              meta: `${t('byAuthor')}: ${(p.author_handle as string) || t('unknown')}`,
            })
          })
        }

        if (groupsData.data) {
          groupsData.data.slice(0, PAGE_SIZE).forEach((g: Record<string, unknown>) => {
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
  }, [query, t, traderFilter])

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
          if (data.length <= PAGE_SIZE) setHasMore(prev => ({ ...prev, users: false }))
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
        const { data } = await supabase.from('trader_sources').select('source_trader_id, handle, source').or(`handle.ilike.%${sanitizedQuery}%,source_trader_id.ilike.%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE * 2)
        if (data) {
          let traders = data
          if (traderFilter.exchange?.length) {
            traders = traders.filter(t =>
              traderFilter.exchange!.some(ex =>
                (t.source || '').toLowerCase().includes(ex.toLowerCase())
              )
            )
          }
          if (traders.length <= PAGE_SIZE) setHasMore(prev => ({ ...prev, traders: false }))
          if (traders.length > 0) {
            const traderKeys = traders.map(t => t.source_trader_id)
            let snapshotQuery = supabase
              .from('trader_snapshots')
              .select('source_trader_id, season_id, roi, arena_score, captured_at')
              .in('source_trader_id', traderKeys)
              .not('arena_score', 'is', null)
            if (traderFilter.period) snapshotQuery = snapshotQuery.eq('season_id', traderFilter.period)
            const { data: allSnapshots } = await snapshotQuery.order('captured_at', { ascending: false })
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
              if (latest) {
                if (traderFilter.roi_min != null && latest.roi < traderFilter.roi_min) continue
                if (traderFilter.roi_max != null && latest.roi > traderFilter.roi_max) continue
                if (traderFilter.min_score != null && latest.arena_score < traderFilter.min_score) continue
              } else if (traderFilter.roi_min != null || traderFilter.roi_max != null || traderFilter.min_score != null) {
                continue
              }
              const platformLabel = (trader.source || '').replace(/_/g, ' ').toUpperCase()
              const subtitle = latest
                ? `${latest.season_id}: ROI ${latest.roi?.toFixed(1)}% | Score ${latest.arena_score?.toFixed(1)}`
                : platformLabel
              newResults.push({
                type: 'trader',
                id: trader.source_trader_id,
                title: trader.handle || trader.source_trader_id,
                subtitle,
                meta: platformLabel || undefined,
              })
              if (newResults.length >= PAGE_SIZE) break
            }
          }
        }
      } else if (type === 'posts') {
        const { data } = await supabase.from('posts').select('id, title, content, author_handle, created_at').or(`title.ilike.%${sanitizedQuery}%,content.ilike.%${sanitizedQuery}%`).range(offset, offset + PAGE_SIZE)
        if (data) {
          if (data.length <= PAGE_SIZE) setHasMore(prev => ({ ...prev, posts: false }))
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
          if (data.length <= PAGE_SIZE) setHasMore(prev => ({ ...prev, groups: false }))
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
  }, [query, offsets, hasMore, loadingMore, showToast, t, traderFilter])

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

  const resultCounts = {
    all: results.length,
    users: results.filter(r => r.type === 'user').length,
    traders: results.filter(r => r.type === 'trader').length,
    posts: results.filter(r => r.type === 'post').length,
    groups: results.filter(r => r.type === 'group').length,
  }

  const getHref = (result: SearchResult) => {
    if (result.type === 'user') return `/u/${encodeURIComponent(result.title)}`
    if (result.type === 'trader') return `/trader/${encodeURIComponent(result.id)}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    return '#'
  }

  const getTypeLabel = (type: string): string => {
    switch (type) {
      case 'user': return t('users')
      case 'trader': return t('traders')
      case 'post': return t('posts')
      case 'group': return t('groups')
      default: return ''
    }
  }

  const getIconLetter = (type: string): string => {
    switch (type) {
      case 'user': return 'U'
      case 'trader': return 'T'
      case 'post': return 'P'
      case 'group': return 'G'
      default: return 'S'
    }
  }

  const getIconStyle = (type: string): { bg: string; color: string; radius: string } => {
    switch (type) {
      case 'user':
        return { bg: 'rgba(139, 111, 168, 0.15)', color: '#8b6fa8', radius: tokens.radius.full }
      case 'trader':
        return { bg: tokens.gradient.successSubtle, color: tokens.colors.accent.success, radius: tokens.radius.full }
      case 'post':
        return { bg: tokens.gradient.primarySubtle, color: tokens.colors.accent.primary, radius: tokens.radius.lg }
      case 'group':
        return { bg: tokens.gradient.warningSubtle, color: tokens.colors.accent.warning, radius: tokens.radius.md }
      default:
        return { bg: tokens.gradient.primarySubtle, color: tokens.colors.accent.primary, radius: tokens.radius.lg }
    }
  }

  // Parse trader ROI for color coding
  const parseRoi = (subtitle: string | undefined): number | null => {
    if (!subtitle) return null
    const match = subtitle.match(/ROI\s+(-?\d+\.?\d*)%/)
    return match ? parseFloat(match[1]) : null
  }

  const renderResultCard = (result: SearchResult) => {
    const iconStyle = getIconStyle(result.type)
    const roi = result.type === 'trader' ? parseRoi(result.subtitle) : null

    return (
      <Link
        key={`${result.type}-${result.id}`}
        href={getHref(result)}
        className="search-result-card"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: tokens.spacing[3],
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
          textDecoration: 'none',
          color: 'inherit',
          transition: tokens.transition.base,
          borderBottom: `1px solid ${tokens.colors.border?.subtle || 'var(--glass-border-light)'}`,
          position: 'relative',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = tokens.glass.bg.light
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      >
        {/* Avatar / Icon */}
        <div style={{
          width: 48,
          height: 48,
          borderRadius: iconStyle.radius,
          background: iconStyle.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.black,
          color: iconStyle.color,
          flexShrink: 0,
        }}>
          {getIconLetter(result.type)}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {/* Row 1: Name + type tag */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginBottom: '2px',
          }}>
            <span style={{
              fontSize: tokens.typography.fontSize.md,
              fontWeight: tokens.typography.fontWeight.bold,
              color: tokens.colors.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {highlightText(result.title, query)}
            </span>
            {/* Type badge - small pill */}
            <span style={{
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: iconStyle.color,
              background: iconStyle.bg,
              padding: '1px 6px',
              borderRadius: tokens.radius.full,
              flexShrink: 0,
              lineHeight: '16px',
            }}>
              {getTypeLabel(result.type)}
            </span>
          </div>

          {/* Row 2: Handle / meta */}
          {result.meta && (
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.tertiary,
              marginBottom: '2px',
            }}>
              {result.meta}
            </div>
          )}

          {/* Row 3: Subtitle / bio / content preview */}
          {result.subtitle && (
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.secondary,
              lineHeight: tokens.typography.lineHeight.normal,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {result.type === 'trader' && roi !== null ? (
                <span>
                  {result.subtitle?.split('ROI')[0]}ROI{' '}
                  <span style={{
                    color: roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                    fontWeight: tokens.typography.fontWeight.bold,
                  }}>
                    {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                  </span>
                  {result.subtitle?.split('%').slice(1).join('%')}
                </span>
              ) : (
                highlightText(result.subtitle, query)
              )}
            </div>
          )}
        </div>
      </Link>
    )
  }

  const renderLoadMoreButton = (type: 'users' | 'traders' | 'posts' | 'groups', label?: string) => {
    if (!hasMore[type]) return null
    const typeLabel = label || t(type).toLowerCase()
    return (
      <button
        key={`load-more-${type}`}
        onClick={() => loadMore(type)}
        disabled={loadingMore[type]}
        className="touch-target"
        style={{
          display: 'block',
          width: '100%',
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: 'transparent',
          border: 'none',
          color: tokens.colors.accent.primary,
          fontWeight: tokens.typography.fontWeight.semibold,
          fontSize: tokens.typography.fontSize.sm,
          cursor: loadingMore[type] ? 'not-allowed' : 'pointer',
          transition: tokens.transition.base,
          opacity: loadingMore[type] ? 0.5 : 1,
          textAlign: 'center',
          minHeight: 48,
        }}
        onMouseEnter={(e) => {
          if (!loadingMore[type]) e.currentTarget.style.background = tokens.glass.bg.light
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
        }}
      >
        {loadingMore[type] ? t('loading') : (activeTab === 'all' ? t('loadMoreType').replace('{type}', typeLabel) : t('loadMore'))}
      </button>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* Background mesh */}
      <div style={{
        position: 'fixed',
        inset: 0,
        background: tokens.gradient.mesh,
        opacity: 0.5,
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      <TopNav email={email} />

      <main className="page-enter" style={{
        maxWidth: 680,
        margin: '0 auto',
        padding: `${tokens.spacing[5]} ${tokens.spacing[4]}`,
        paddingBottom: tokens.spacing[20],
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Search header */}
        {query && (
          <div style={{
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.text.tertiary,
            padding: `${tokens.spacing[4]} 0 ${tokens.spacing[3]}`,
            fontWeight: tokens.typography.fontWeight.medium,
          }}>
            {t('searchResults')}: <span style={{ color: tokens.colors.text.primary, fontWeight: tokens.typography.fontWeight.semibold }}>&quot;{query}&quot;</span>
          </div>
        )}

        {/* Tab bar - sticky, compact, underline style */}
        {query && (
          <div style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            background: tokens.colors.bg.primary,
            borderBottom: `1px solid ${tokens.colors.border?.subtle || 'var(--glass-border-light)'}`,
            marginLeft: `-${tokens.spacing[4]}`,
            marginRight: `-${tokens.spacing[4]}`,
            paddingLeft: tokens.spacing[4],
            paddingRight: tokens.spacing[4],
          }}>
            <div style={{
              display: 'flex',
              gap: 0,
              overflowX: 'auto',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}>
              {(['all', 'users', 'traders', 'posts', 'groups'] as const).map((tab) => {
                const isActive = activeTab === tab
                const count = resultCounts[tab]
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className="touch-target"
                    style={{
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      background: 'transparent',
                      border: 'none',
                      borderBottom: isActive ? `2px solid ${tokens.colors.accent.primary}` : '2px solid transparent',
                      color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                      fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                      fontSize: tokens.typography.fontSize.sm,
                      cursor: 'pointer',
                      transition: tokens.transition.fast,
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      minHeight: 44,
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.color = tokens.colors.text.secondary
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.color = tokens.colors.text.tertiary
                    }}
                  >
                    {{ all: t('all'), users: t('users'), traders: t('traders'), posts: t('posts'), groups: t('groups') }[tab]}
                    {count > 0 && (
                      <span style={{
                        marginLeft: '4px',
                        fontSize: tokens.typography.fontSize.xs,
                        color: isActive ? tokens.colors.text.secondary : tokens.colors.text.tertiary,
                      }}>
                        ({count > 99 ? '99+' : count})
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Advanced filter for traders tab */}
        {query && activeTab === 'traders' && (
          <TraderSearchFilter
            filter={traderFilter}
            onFilterChange={setTraderFilter}
            isVisible={isFilterVisible}
            onToggle={() => setIsFilterVisible(prev => !prev)}
          />
        )}

        {/* Results */}
        {loading ? (
          <div>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
                borderBottom: `1px solid ${tokens.colors.border?.subtle || 'var(--glass-border-light)'}`,
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.bg.tertiary,
                  animation: 'pulse 1.5s ease-in-out infinite',
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{
                    width: `${40 + i * 8}%`,
                    height: 14,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    marginBottom: 8,
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
                  <div style={{
                    width: `${25 + i * 5}%`,
                    height: 11,
                    borderRadius: tokens.radius.sm,
                    background: tokens.colors.bg.tertiary,
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
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
          <div style={{
            textAlign: 'center',
            padding: `${tokens.spacing[20]} ${tokens.spacing[4]}`,
          }}>
            <div style={{
              width: 64,
              height: 64,
              borderRadius: tokens.radius.full,
              background: tokens.gradient.primarySubtle,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              marginBottom: tokens.spacing[5],
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <div style={{
              fontSize: tokens.typography.fontSize.lg,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: tokens.colors.text.primary,
              marginBottom: tokens.spacing[2],
            }}>
              {t('startSearching')}
            </div>
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.tertiary,
              lineHeight: tokens.typography.lineHeight.relaxed,
              maxWidth: 320,
              margin: '0 auto',
            }}>
              {t('startSearchingDesc')}
            </div>
          </div>
        ) : filteredResults.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: `${tokens.spacing[16]} ${tokens.spacing[4]}`,
          }}>
            <div style={{
              fontSize: tokens.typography.fontSize['2xl'],
              marginBottom: tokens.spacing[3],
              opacity: 0.3,
            }}>
              /
            </div>
            <div style={{
              fontSize: tokens.typography.fontSize.md,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: tokens.colors.text.primary,
              marginBottom: tokens.spacing[2],
            }}>
              {t('noResults')}
            </div>
            <div style={{
              fontSize: tokens.typography.fontSize.sm,
              color: tokens.colors.text.tertiary,
            }}>
              {t('noResultsForQuery').replace('{query}', query)}
            </div>
          </div>
        ) : (
          <div className="stagger-children search-results" style={{
            background: tokens.glass.bg.secondary,
            borderRadius: tokens.radius.xl,
            border: tokens.glass.border.light,
            overflow: 'hidden',
            marginTop: tokens.spacing[3],
          }}>
            {filteredResults.map((result) => renderResultCard(result))}

            {/* Load More buttons */}
            {activeTab !== 'all' && renderLoadMoreButton(activeTab as 'users' | 'traders' | 'posts' | 'groups')}

            {activeTab === 'all' && (
              <>
                {(['users', 'traders', 'posts', 'groups'] as const).map((type) => {
                  const typeKey = type === 'users' ? 'user' : type === 'traders' ? 'trader' : type === 'posts' ? 'post' : 'group'
                  const typeResults = results.filter(r => r.type === typeKey)
                  if (typeResults.length === 0) return null
                  return renderLoadMoreButton(type, t(type).toLowerCase())
                })}
              </>
            )}
          </div>
        )}
      </main>

      {/* Hide scrollbar on tab bar */}
      <style>{`
        .search-result-card:last-child {
          border-bottom: none !important;
        }
        .search-result-card {
          min-height: 56px;
        }
        @media (max-width: 640px) {
          main {
            padding-left: ${tokens.spacing[3]} !important;
            padding-right: ${tokens.spacing[3]} !important;
          }
        }
      `}</style>
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
        <TopNav email={null} />
        <main style={{ maxWidth: 680, margin: '0 auto', padding: '20px 16px' }}>
          <div style={{ marginTop: 60 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '12px',
                padding: '16px',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.06)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{
                    width: `${40 + i * 8}%`,
                    height: 14,
                    borderRadius: '4px',
                    background: 'rgba(255,255,255,0.06)',
                    marginBottom: 8,
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
                  <div style={{
                    width: `${25 + i * 5}%`,
                    height: 11,
                    borderRadius: '4px',
                    background: 'rgba(255,255,255,0.06)',
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
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
