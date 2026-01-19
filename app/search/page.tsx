'use client'

import { useEffect, useState, Suspense, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import EmptyState from '@/app/components/UI/EmptyState'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'

type SearchResult = {
  type: 'trader' | 'post' | 'group'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

// 高亮样式 - 使用 CSS 变量实现主题一致性
const HIGHLIGHT_STYLE = {
  backgroundColor: 'rgba(139, 111, 168, 0.4)',
  color: '#d4b8e8',
  borderRadius: '4px',
  padding: '1px 4px',
  fontWeight: 600,
}

function SearchContent() {
  const searchParams = useSearchParams()
  const query = searchParams.get('q') || ''
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'all' | 'traders' | 'posts' | 'groups'>('all')

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
      const results: SearchResult[] = []

      try {
        // 搜索交易者
        // 交易员数据来自 trader_sources（避免不存在的 traders 表）
        const { data: traders } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, source')
          .ilike('handle', `%${query}%`)
          .limit(10)

        if (traders) {
          traders.forEach((t: any) => {
            results.push({
              type: 'trader',
              id: t.source_trader_id,
              title: t.handle,
              subtitle: `来源: ${String(t.source || '').toUpperCase()}`,
            })
          })
        }

        // 搜索帖子
        const { data: posts } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, created_at')
          .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
          .limit(10)

        if (posts) {
          posts.forEach((p: any) => {
            results.push({
              type: 'post',
              id: p.id,
              title: p.title,
              subtitle: p.content?.substring(0, 100),
              meta: `作者: ${p.author_handle || '未知'}`,
            })
          })
        }

        // 搜索小组
        const { data: groups } = await supabase
          .from('groups')
          .select('id, name')
          .ilike('name', `%${query}%`)
          .limit(10)

        if (groups) {
          groups.forEach((g: any) => {
            results.push({
              type: 'group',
              id: g.id,
              title: g.name,
              subtitle: '',
            })
          })
        }

        setResults(results)
      } catch (error) {
        console.error('Search error:', error)
      } finally {
        setLoading(false)
      }
    }

    const timeout = setTimeout(search, 300)
    return () => clearTimeout(timeout)
  }, [query])

  const filteredResults = activeTab === 'all' 
    ? results 
    : results.filter(r => {
        if (activeTab === 'traders') return r.type === 'trader'
        if (activeTab === 'groups') return r.type === 'group'
        if (activeTab === 'posts') return r.type === 'post'
        return false
      })

  const getHref = (result: SearchResult) => {
    if (result.type === 'trader') return `/trader/${encodeURIComponent(result.title)}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    return '#'
  }

  const getIcon = (type: string) => {
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
            {(['all', 'traders', 'posts', 'groups'] as const).map((tab) => (
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
                {tab === 'all' ? '全部' : tab === 'traders' ? '交易者' : tab === 'posts' ? '帖子' : '小组'}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <RankingSkeleton />
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
                    background: result.type === 'trader' 
                      ? tokens.gradient.successSubtle 
                      : result.type === 'post' 
                        ? tokens.gradient.primarySubtle 
                        : tokens.gradient.warningSubtle,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '18px',
                    fontWeight: 900,
                    color: result.type === 'trader' 
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

