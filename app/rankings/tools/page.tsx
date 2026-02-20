'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards, { type LeaderboardEntry } from '@/app/components/ui/TopLeaderboards'
import dynamic from 'next/dynamic'

// MobileBottomNav is rendered by root layout — do not duplicate here

interface Tool {
  id: string
  name: string
  name_zh: string | null
  category: string
  logo_url: string | null
  website: string | null
  github_url: string | null
  description: string | null
  description_zh: string | null
  pricing: string | null
  avg_rating: number | null
  rating_count: number
  tags: string[] | null
}

const CATEGORY_FILTERS = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'trading_tool', zh: '交易工具', en: 'Trading Tools' },
  { key: 'trading-bot', zh: '交易机器人', en: 'Trading Bots' },
  { key: 'copytrading', zh: '跟单', en: 'Copy Trading' },
  { key: 'quant_platform', zh: '量化平台', en: 'Quant Platforms' },
  { key: 'analytics', zh: '分析工具', en: 'Analytics', isGroup: true },
  { key: 'wallets', zh: '钱包', en: 'Wallets', isGroup: true },
  { key: 'dev-tools', zh: '开发工具', en: 'Dev Tools', isGroup: true },
  { key: 'compliance-tax', zh: '合规/税务', en: 'Compliance & Tax', isGroup: true },
  { key: 'info', zh: '资讯', en: 'News & Info', isGroup: true },
  { key: 'strategy', zh: '策略', en: 'Strategies' },
  { key: 'script', zh: '脚本', en: 'Scripts' },
  { key: 'charting', zh: '图表', en: 'Charting' },
  { key: 'signal', zh: '信号', en: 'Signals' },
]

const TOOL_CATEGORY_GROUPS: Record<string, string[]> = {
  analytics: ['on-chain-analytics', 'defi-analytics', 'portfolio-tracker', 'whale-tracking', 'sentiment'],
  wallets: ['hot-wallet', 'hardware-wallet', 'multisig', 'mpc-wallet', 'smart-wallet', 'wallet-infra'],
  'dev-tools': ['rpc-node', 'indexer', 'api', 'testing', 'deployment', 'sdk', 'security-tool'],
  'compliance-tax': ['tax', 'compliance-tool', 'accounting'],
  info: ['news-aggregator', 'calendar', 'alert'],
}

const SORT_OPTIONS = [
  { key: 'rating', zh: '评分最高', en: 'Highest Rated' },
  { key: 'newest', zh: '最新', en: 'Newest' },
  { key: 'reviews', zh: '评价最多', en: 'Most Reviews' },
]

const PRICING_LABELS: Record<string, { zh: string; en: string }> = {
  free: { zh: '免费', en: 'Free' },
  freemium: { zh: '免费增值', en: 'Freemium' },
  paid: { zh: '付费', en: 'Paid' },
  open_source: { zh: '开源', en: 'Open Source' },
}

const TradingIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
)

const QuantIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="12" y1="4" x2="12" y2="20" />
  </svg>
)

const CodeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
)

function toolToEntry(tool: Tool, isZh: boolean): LeaderboardEntry {
  return {
    id: tool.id,
    name: isZh ? (tool.name_zh || tool.name) : tool.name,
    rating: tool.avg_rating,
    logoUrl: tool.logo_url,
    href: tool.website || tool.github_url,
  }
}


export default function ToolsPage() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('rating')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Debounce search input
  useEffect(() => {
    clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(searchTimerRef.current)
  }, [search])

  // Leaderboard data
  const [topTrading, setTopTrading] = useState<Tool[]>([])
  const [topQuant, setTopQuant] = useState<Tool[]>([])
  const [topScripts, setTopScripts] = useState<Tool[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  useEffect(() => {
    async function fetchLeaderboards() {
      setLeaderboardLoading(true)
      try {
        const fetchScripts = async () => {
          const { data } = await supabase
            .from('tools')
            .select('id, name, name_zh, category, logo_url, website, github_url, description, description_zh, pricing, avg_rating, rating_count, tags')
            .eq('is_active', true)
            .or('category.eq.script,category.eq.strategy')
            .order('avg_rating', { ascending: false, nullsFirst: false })
            .limit(10)
          return data || []
        }
        const fetchTopMulti = async (cats: string[]) => {
          const { data } = await supabase
            .from('tools')
            .select('id, name, name_zh, category, logo_url, website, github_url, description, description_zh, pricing, avg_rating, rating_count, tags')
            .eq('is_active', true)
            .in('category', cats)
            .order('avg_rating', { ascending: false, nullsFirst: false })
            .limit(10)
          return data || []
        }
        const [trading, quant, scripts] = await Promise.all([
          fetchTopMulti(['trading_tool', 'trading-bot', 'copytrading', 'charting', 'signal']),
          fetchTopMulti(['quant_platform', 'quant-framework']),
          fetchScripts(),
        ])
        setTopTrading(trading)
        setTopQuant(quant)
        setTopScripts(scripts)
      } catch {
        // ignore
      } finally {
        setLeaderboardLoading(false)
      }
    }
    fetchLeaderboards()
  }, [])

  // Fetch counts per category for filter badges
  useEffect(() => {
    async function fetchCounts() {
      try {
        const { data } = await supabase
          .from('tools')
          .select('category')
          .eq('is_active', true)
        if (!data) return
        const counts: Record<string, number> = { all: data.length }
        data.forEach(row => {
          const cat = row.category as string
          counts[cat] = (counts[cat] || 0) + 1
        })
        // Compute group counts
        Object.entries(TOOL_CATEGORY_GROUPS).forEach(([groupKey, cats]) => {
          counts[groupKey] = cats.reduce((sum, c) => sum + (counts[c] || 0), 0)
        })
        setCategoryCounts(counts)
      } catch {
        // ignore — counts are optional UI decoration
      }
    }
    fetchCounts()
  }, [])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = supabase
        .from('tools')
        .select('id, name, name_zh, category, logo_url, website, github_url, description, description_zh, pricing, avg_rating, rating_count, tags')
        .eq('is_active', true)

      if (category !== 'all') {
        const groupCats = TOOL_CATEGORY_GROUPS[category]
        if (groupCats) {
          query = query.in('category', groupCats)
        } else {
          query = query.eq('category', category)
        }
      }

      if (debouncedSearch.trim()) {
        query = query.or(`name.ilike.%${debouncedSearch.trim()}%,name_zh.ilike.%${debouncedSearch.trim()}%`)
      }

      if (sort === 'rating') {
        query = query.order('avg_rating', { ascending: false, nullsFirst: false })
      } else if (sort === 'newest') {
        query = query.order('created_at', { ascending: false })
      } else if (sort === 'reviews') {
        query = query.order('rating_count', { ascending: false })
      }

      query = query.limit(100)

      const { data, error: queryError } = await query
      if (queryError) throw queryError
      setTools(data || [])
    } catch {
      setError(isZh ? '加载失败，请重试' : 'Failed to load, please retry')
    } finally {
      setLoading(false)
    }
  }, [category, sort, debouncedSearch, isZh])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 100px' }}>

        {/* Top Leaderboards */}
        <TopLeaderboards columns={[
          {
            title: isZh ? '交易工具 Top 10' : 'Top 10 Trading Tools',
            icon: <TradingIcon />,
            entries: topTrading.map(t => toolToEntry(t, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '量化平台 Top 10' : 'Top 10 Quant Platforms',
            icon: <QuantIcon />,
            entries: topQuant.map(t => toolToEntry(t, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '开源脚本 Top 10' : 'Top 10 Scripts',
            icon: <CodeIcon />,
            entries: topScripts.map(t => toolToEntry(t, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
        ]} />

        {/* Tools page header — teal accent differentiates from Institutions (purple) */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: tokens.radius.lg,
              background: 'var(--color-tools-accent-muted)',
              border: '1px solid var(--color-tools-accent)',
              color: 'var(--color-tools-accent)',
              flexShrink: 0,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </span>
            <h1 style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: 800,
              background: 'var(--color-tools-gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              margin: 0,
              letterSpacing: '-0.02em',
            }}>
              {isZh ? '工具' : 'Tools'}
            </h1>
          </div>
          <p style={{ fontSize: tokens.typography.fontSize.base, color: 'var(--color-text-tertiary)', marginBottom: 24, lineHeight: tokens.typography.lineHeight.normal }}>
            {isZh ? '发现并评价加密行业中的顶级工具' : 'Discover and rate top tools in crypto'}
          </p>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          {CATEGORY_FILTERS.map(f => {
            const active = category === f.key
            const count = categoryCounts[f.key]
            return (
              <button
                key={f.key}
                onClick={() => setCategory(f.key)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '9px 18px',
                  borderRadius: tokens.radius.full,
                  fontSize: tokens.typography.fontSize.base,
                  fontWeight: active ? 700 : 500,
                  border: active ? '1px solid transparent' : '1px solid var(--color-border-primary)',
                  background: active ? 'var(--color-tools-gradient)' : 'var(--color-bg-secondary)',
                  color: active ? '#fff' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.base}`,
                  boxShadow: active ? `0 2px 12px var(--color-tools-accent-muted)` : 'none',
                  letterSpacing: '0.01em',
                }}
                onMouseEnter={e => {
                  if (!active) {
                    e.currentTarget.style.borderColor = 'var(--color-tools-accent)'
                    e.currentTarget.style.color = 'var(--color-text-primary)'
                    e.currentTarget.style.background = 'var(--color-tools-accent-muted)'
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                    e.currentTarget.style.color = 'var(--color-text-secondary)'
                    e.currentTarget.style.background = 'var(--color-bg-secondary)'
                  }
                }}
              >
                {isZh ? f.zh : f.en}
                {count != null && count > 0 && (
                  <span style={{
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: tokens.radius.full,
                    background: active ? 'rgba(255,255,255,0.22)' : 'var(--color-tools-accent-muted)',
                    color: active ? '#fff' : 'var(--color-tools-accent)',
                    lineHeight: '1.5',
                    minWidth: 20,
                    textAlign: 'center' as const,
                  }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{
              padding: '9px 14px', borderRadius: tokens.radius.full,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm, cursor: 'pointer', outline: 'none', marginLeft: 'auto',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.key} value={opt.key}>{isZh ? opt.zh : opt.en}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: 400, marginBottom: 28 }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={isZh ? '搜索工具...' : 'Search tools...'}
            style={{
              width: '100%', padding: '10px 16px', borderRadius: tokens.radius.full,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.base, outline: 'none',
              transition: `all ${tokens.transition.base}`,
            }}
            onFocus={e => {
              e.currentTarget.style.borderColor = 'var(--color-brand)'
              e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-brand-muted)'
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = 'var(--color-border-primary)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          />
        </div>

        {/* List */}
        {error ? (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <p style={{ color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.base, marginBottom: 16 }}>{error}</p>
            <button
              onClick={fetchData}
              style={{
                padding: '8px 20px', borderRadius: tokens.radius.full,
                background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-primary)', cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {isZh ? '重试' : 'Retry'}
            </button>
          </div>
        ) : loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 20 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 140, borderRadius: tokens.radius.xl }} />
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.base }}>
            {isZh ? '暂无数据' : 'No tools found'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 20 }}>
            {tools.map(tool => (
              <ToolCard key={tool.id} tool={tool} isZh={isZh} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function ToolCard({ tool, isZh }: { tool: Tool; isZh: boolean }) {
  const name = isZh ? (tool.name_zh || tool.name) : tool.name
  const desc = isZh ? (tool.description_zh || tool.description) : tool.description
  const pricingLabel = tool.pricing ? PRICING_LABELS[tool.pricing]?.[isZh ? 'zh' : 'en'] || tool.pricing : null

  return (
    <a
      href={tool.website || tool.github_url || '#'}
      target={(tool.website || tool.github_url) ? '_blank' : undefined}
      rel="noopener noreferrer"
      style={{
        display: 'block',
        padding: 20,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-secondary)',
        textDecoration: 'none',
        transition: `all ${tokens.transition.base}`,
        boxShadow: tokens.shadow.xs,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--color-brand-muted)'
        e.currentTarget.style.transform = 'translateY(-3px)'
        e.currentTarget.style.boxShadow = tokens.shadow.cardHover
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--color-border-primary)'
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = tokens.shadow.xs
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
        {tool.logo_url ? (
          <img
            src={tool.logo_url}
            alt={`${tool.name} logo`}
            width={44}
            height={44}
            style={{ borderRadius: tokens.radius.xl, objectFit: 'cover', flexShrink: 0 }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: tokens.radius.xl, flexShrink: 0,
            background: tokens.gradient.primarySubtle,
            border: '1px solid var(--color-border-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: tokens.typography.fontSize.md, fontWeight: tokens.typography.fontWeight.bold, color: 'var(--color-brand)',
          }}>
            {name[0]}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: tokens.typography.fontSize.base, fontWeight: tokens.typography.fontWeight.bold,
            color: 'var(--color-text-primary)', marginBottom: 4, lineHeight: tokens.typography.lineHeight.tight,
          }}>{name}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)' }}>
            <span>{CATEGORY_FILTERS.find(f => f.key === tool.category)?.[isZh ? 'zh' : 'en'] || tool.category}</span>
            {pricingLabel && (
              <span style={{
                padding: '2px 8px',
                borderRadius: tokens.radius.full,
                background: tool.pricing === 'free' || tool.pricing === 'open_source' ? 'var(--color-accent-success-12)' : tool.pricing === 'paid' ? 'var(--color-accent-warning-12, rgba(255, 184, 0, 0.12))' : 'var(--color-accent-primary-08)',
                color: tool.pricing === 'free' || tool.pricing === 'open_source' ? 'var(--color-accent-success)' : tool.pricing === 'paid' ? 'var(--color-accent-warning, #FFB800)' : 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.semibold,
                lineHeight: '1.4',
              }}>
                {pricingLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {desc && (
        <p style={{
          fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)',
          lineHeight: tokens.typography.lineHeight.normal, margin: '0 0 12px',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
        }}>
          {desc}
        </p>
      )}

      {tool.tags && tool.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {tool.tags.slice(0, 3).map((tag, i) => (
            <span key={i} style={{
              padding: '2px 10px',
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.medium,
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-tertiary)',
              border: '1px solid var(--color-border-secondary)',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Prominent star rating with score highlight */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: tokens.radius.lg,
        background: (tool.avg_rating && tool.avg_rating > 0) ? 'var(--color-tools-accent-muted)' : 'transparent',
        border: (tool.avg_rating && tool.avg_rating > 0) ? '1px solid var(--color-tools-accent)' : 'none',
        width: 'fit-content',
      }}>
        <StarRating
          rating={tool.avg_rating || 0}
          ratingCount={tool.rating_count}
          size={16}
          readonly
        />
      </div>
    </a>
  )
}
