'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards, { type LeaderboardEntry } from '@/app/components/ui/TopLeaderboards'
import dynamic from 'next/dynamic'

const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })

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
  { key: 'quant_platform', zh: '量化平台', en: 'Quant Platforms' },
  { key: 'strategy', zh: '策略', en: 'Strategies' },
  { key: 'script', zh: '脚本', en: 'Scripts' },
]

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

  // Leaderboard data
  const [topTrading, setTopTrading] = useState<Tool[]>([])
  const [topQuant, setTopQuant] = useState<Tool[]>([])
  const [topScripts, setTopScripts] = useState<Tool[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  useEffect(() => {
    async function fetchLeaderboards() {
      setLeaderboardLoading(true)
      try {
        const fetchTop = async (cat: string) => {
          const { data } = await supabase
            .from('tools')
            .select('id, name, name_zh, category, logo_url, website, github_url, description, description_zh, pricing, avg_rating, rating_count, tags')
            .eq('is_active', true)
            .eq('category', cat)
            .order('avg_rating', { ascending: false, nullsFirst: false })
            .limit(10)
          return data || []
        }
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
        const [trading, quant, scripts] = await Promise.all([
          fetchTop('trading_tool'), fetchTop('quant_platform'), fetchScripts(),
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

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase
        .from('tools')
        .select('id, name, name_zh, category, logo_url, website, github_url, description, description_zh, pricing, avg_rating, rating_count, tags')
        .eq('is_active', true)

      if (category !== 'all') {
        query = query.eq('category', category)
      }

      if (search.trim()) {
        query = query.or(`name.ilike.%${search.trim()}%,name_zh.ilike.%${search.trim()}%`)
      }

      if (sort === 'rating') {
        query = query.order('avg_rating', { ascending: false, nullsFirst: false })
      } else if (sort === 'newest') {
        query = query.order('created_at', { ascending: false })
      } else if (sort === 'reviews') {
        query = query.order('rating_count', { ascending: false })
      }

      query = query.limit(100)

      const { data } = await query
      setTools(data || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [category, sort, search])

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

        <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: 800, color: 'var(--color-text-primary)', marginBottom: 20 }}>
          {isZh ? '工具' : 'Tools'}
        </h1>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          {CATEGORY_FILTERS.map(f => {
            const active = category === f.key
            return (
              <button
                key={f.key}
                onClick={() => setCategory(f.key)}
                style={{
                  padding: '8px 18px',
                  borderRadius: tokens.radius.lg,
                  fontSize: 14,
                  fontWeight: active ? 700 : 500,
                  border: active ? 'none' : '1px solid var(--color-border-primary)',
                  background: active ? tokens.gradient.purpleGold : 'var(--color-bg-secondary)',
                  color: active ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {isZh ? f.zh : f.en}
              </button>
            )
          })}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{
              padding: '8px 14px', borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: 13, cursor: 'pointer', outline: 'none', marginLeft: 'auto',
            }}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.key} value={opt.key}>{isZh ? opt.zh : opt.en}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div style={{ position: 'relative', maxWidth: 400, marginBottom: 24 }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={isZh ? '搜索工具...' : 'Search tools...'}
            style={{
              width: '100%', padding: '10px 14px', borderRadius: tokens.radius.lg,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: 14, outline: 'none',
            }}
          />
        </div>

        {/* List */}
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 120, borderRadius: tokens.radius.xl }} />
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-tertiary)' }}>
            {isZh ? '暂无数据' : 'No tools found'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {tools.map(tool => (
              <ToolCard key={tool.id} tool={tool} isZh={isZh} />
            ))}
          </div>
        )}
      </main>
      <MobileBottomNav />
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
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--color-brand)'
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = tokens.shadow.md
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--color-border-primary)'
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {tool.logo_url ? (
          <img
            src={tool.logo_url}
            alt=""
            width={40}
            height={40}
            style={{ borderRadius: tokens.radius.lg, objectFit: 'cover' }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div style={{
            width: 40, height: 40, borderRadius: tokens.radius.lg,
            background: 'var(--color-accent-primary-12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 700, color: 'var(--color-brand)',
          }}>
            {name[0]}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 2 }}>{name}</div>
          <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
            <span>{CATEGORY_FILTERS.find(f => f.key === tool.category)?.[isZh ? 'zh' : 'en'] || tool.category}</span>
            {pricingLabel && (
              <span style={{
                padding: '1px 8px',
                borderRadius: tokens.radius.md,
                background: tool.pricing === 'free' || tool.pricing === 'open_source' ? 'var(--color-accent-success-12)' : 'var(--color-accent-primary-08)',
                color: tool.pricing === 'free' || tool.pricing === 'open_source' ? 'var(--color-accent-success)' : 'var(--color-text-secondary)',
                fontSize: 11,
                fontWeight: 600,
              }}>
                {pricingLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {desc && (
        <p style={{
          fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: '0 0 10px',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
        }}>
          {desc}
        </p>
      )}

      <StarRating
        rating={tool.avg_rating || 0}
        ratingCount={tool.rating_count}
        size={14}
        readonly
      />
    </a>
  )
}
