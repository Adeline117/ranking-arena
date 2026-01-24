'use client'

import { useEffect, useState, Suspense, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import EmptyState from '@/app/components/ui/EmptyState'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { useToast } from '@/app/components/ui/Toast'
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

function SearchContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const query = searchParams.get('q') || ''
  const tabParam = searchParams.get('tab') as TabType | null
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const activeTab: TabType = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'all'
  const [searchError, setSearchError] = useState(false)
  const { showToast } = useToast()

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

        // 并行查询所有数据源
        const [usersData, tradersData, postsData, groupsData] = await Promise.all([
          // 搜索用户
          isNumericQuery
            ? supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').eq('uid', parseInt(query.trim())).limit(10)
            : supabase.from('user_profiles').select('id, handle, avatar_url, bio, uid').ilike('handle', `%${sanitizedQuery}%`).limit(10),
          // 搜索交易者（v2 表）
          supabase.from('trader_sources_v2').select('trader_key, display_name, platform').ilike('display_name', `%${sanitizedQuery}%`).limit(10),
          // 搜索帖子
          supabase.from('posts').select('id, title, content, author_handle, created_at').or(`title.ilike.%${sanitizedQuery}%,content.ilike.%${sanitizedQuery}%`).limit(10),
          // 搜索小组
          supabase.from('groups').select('id, name').ilike('name', `%${sanitizedQuery}%`).limit(10),
        ])

        // 处理用户结果
        if (usersData.data) {
          usersData.data.forEach((u: Record<string, unknown>) => {
            results.push({
              type: 'user',
              id: u.id as string,
              title: (u.handle as string) || '未设置昵称',
              subtitle: ((u.bio as string) || '').substring(0, 80),
              meta: u.uid ? `UID: ${u.uid}` : undefined,
              uid: u.uid as number | undefined,
            })
          })
        }

        // 处理交易员结果 - 批量获取快照数据
        const traders = tradersData.data
        if (traders && traders.length > 0) {
          const traderKeys = traders.map(t => t.trader_key)
          const { data: allSnapshots } = await supabase
            .from('trader_snapshots_v2')
            .select('trader_key, window, roi_pct, arena_score, as_of_ts')
            .in('trader_key', traderKeys)
            .not('arena_score', 'is', null)
            .order('as_of_ts', { ascending: false })

          // 构建映射（优先 90d > 30d > 7d）
          const snapshotMap = new Map<string, { window: string; roi_pct: number; arena_score: number }>()
          const windowPriority: Record<string, number> = { '90d': 3, '30d': 2, '7d': 1 }

          allSnapshots?.forEach((s: Record<string, unknown>) => {
            const key = s.trader_key as string
            const existing = snapshotMap.get(key)
            const currentP = windowPriority[s.window as string] || 0
            const existingP = existing ? (windowPriority[existing.window] || 0) : 0
            if (!existing || currentP > existingP) {
              snapshotMap.set(key, { window: s.window as string, roi_pct: s.roi_pct as number, arena_score: s.arena_score as number })
            }
          })

          for (const trader of traders) {
            const latest = snapshotMap.get(trader.trader_key)
            const platformLabel = (trader.platform || '').replace(/_/g, ' ').toUpperCase()
            const subtitle = latest
              ? `${latest.window}: ROI ${latest.roi_pct?.toFixed(1)}% • Score ${latest.arena_score?.toFixed(1)}`
              : platformLabel
            results.push({
              type: 'trader',
              id: trader.trader_key,
              title: trader.display_name || trader.trader_key,
              subtitle,
              meta: platformLabel || undefined,
            })
          }
        }

        // 处理帖子结果
        if (postsData.data) {
          postsData.data.forEach((p: Record<string, unknown>) => {
            results.push({
              type: 'post',
              id: p.id as string,
              title: (p.title as string) || '',
              subtitle: ((p.content as string) || '').substring(0, 100),
              meta: `作者: ${(p.author_handle as string) || '未知'}`,
            })
          })
        }

        // 处理小组结果
        if (groupsData.data) {
          groupsData.data.forEach((g: Record<string, unknown>) => {
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
      } catch (error) {
        console.error('Search error:', error)
        setSearchError(true)
        showToast('搜索失败，请稍后重试', 'error')
      } finally {
        setLoading(false)
      }
    }

    const timeout = setTimeout(search, 300)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const filteredResults = activeTab === 'all' 
    ? results 
    : results.filter(r => {
        if (activeTab === 'users') return r.type === 'user'
        if (activeTab === 'traders') return r.type === 'trader'
        if (activeTab === 'groups') return r.type === 'group'
        if (activeTab === 'posts') return r.type === 'post'
        return false
      })

  const getHref = (result: SearchResult) => {
    if (result.type === 'user') return `/u/${encodeURIComponent(result.title)}`
    if (result.type === 'trader') return `/trader/${encodeURIComponent(result.title)}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    return '#'
  }

  const getIcon = (type: string) => {
    if (type === 'user') return 'U'
    if (type === 'trader') return 'T'
    if (type === 'post') return 'P'
    if (type === 'group') return 'G'
    return 'S'
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
      
      <main className="page-enter" style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px', position: 'relative', zIndex: 1 }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 className="search-title gradient-text" style={{ fontSize: '28px', fontWeight: 950, marginBottom: '8px' }}>
            搜索结果
          </h1>
          <div style={{ fontSize: '14px', color: tokens.colors.text.tertiary }}>
            {query ? `搜索: "${query}"` : '请输入搜索关键词'}
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
                {tab === 'all' ? '全部' : tab === 'users' ? '用户' : tab === 'traders' ? '交易者' : tab === 'posts' ? '帖子' : '小组'}
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
            title="搜索失败"
            description="请稍后重试"
          />
        ) : !query ? (
          <EmptyState 
            title="开始搜索"
            description="在顶部搜索栏输入关键词，搜索交易者、帖子或小组"
          />
        ) : filteredResults.length === 0 ? (
          <EmptyState 
            title="未找到结果"
            description={`没有找到与"${query}"相关的内容`}
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
                    background: result.type === 'user'
                      ? 'linear-gradient(135deg, rgba(139, 111, 168, 0.2), rgba(139, 111, 168, 0.1))'
                      : result.type === 'trader' 
                        ? tokens.gradient.successSubtle 
                        : result.type === 'post' 
                          ? tokens.gradient.primarySubtle 
                          : tokens.gradient.warningSubtle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px',
                    fontWeight: 900,
                    color: result.type === 'user'
                      ? '#8b6fa8'
                      : result.type === 'trader' 
                        ? tokens.colors.accent.success 
                        : result.type === 'post' 
                          ? tokens.colors.accent.primary 
                          : tokens.colors.accent.warning,
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
          <RankingSkeleton />
        </main>
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}

