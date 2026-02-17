'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards, { type LeaderboardEntry } from '@/app/components/ui/TopLeaderboards'
import dynamic from 'next/dynamic'

const MobileBottomNav = dynamic(() => import('@/app/components/layout/MobileBottomNav'), { ssr: false })

interface Institution {
  id: string
  name: string
  name_zh: string | null
  category: string
  logo_url: string | null
  website: string | null
  description: string | null
  description_zh: string | null
  avg_rating: number | null
  rating_count: number
  tags: string[] | null
}

const CATEGORY_FILTERS = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'fund', zh: '机构', en: 'Funds' },
  { key: 'project', zh: '项目方', en: 'Projects' },
  { key: 'exchange', zh: '交易所', en: 'Exchanges' },
]

const SORT_OPTIONS = [
  { key: 'rating', zh: '评分最高', en: 'Highest Rated' },
  { key: 'newest', zh: '最新', en: 'Newest' },
  { key: 'reviews', zh: '评价最多', en: 'Most Reviews' },
]

const FundIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)

const ProjectIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
)

const ExchangeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
  </svg>
)

function instToEntry(inst: Institution, isZh: boolean): LeaderboardEntry {
  return {
    id: inst.id,
    name: isZh ? (inst.name_zh || inst.name) : inst.name,
    rating: inst.avg_rating,
    logoUrl: inst.logo_url,
    href: inst.website,
  }
}

export default function InstitutionsPage() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [institutions, setInstitutions] = useState<Institution[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('rating')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Debounce search input
  useEffect(() => {
    clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(searchTimerRef.current)
  }, [search])

  // Leaderboard data
  const [topFunds, setTopFunds] = useState<Institution[]>([])
  const [topProjects, setTopProjects] = useState<Institution[]>([])
  const [topExchanges, setTopExchanges] = useState<Institution[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  // Fetch leaderboard data once
  useEffect(() => {
    async function fetchLeaderboards() {
      setLeaderboardLoading(true)
      try {
        const fetchTop = async (cat: string) => {
          const { data } = await supabase
            .from('institutions')
            .select('id, name, name_zh, category, logo_url, website, description, description_zh, avg_rating, rating_count, tags')
            .eq('is_active', true)
            .eq('category', cat)
            .order('avg_rating', { ascending: false, nullsFirst: false })
            .limit(10)
          return data || []
        }
        const [funds, projects, exchanges] = await Promise.all([
          fetchTop('fund'), fetchTop('project'), fetchTop('exchange'),
        ])
        setTopFunds(funds)
        setTopProjects(projects)
        setTopExchanges(exchanges)
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
    setError(null)
    try {
      let query = supabase
        .from('institutions')
        .select('id, name, name_zh, category, logo_url, website, description, description_zh, avg_rating, rating_count, tags')
        .eq('is_active', true)

      if (category !== 'all') {
        query = query.eq('category', category)
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
      setInstitutions(data || [])
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
            title: isZh ? '顶级基金 Top 10' : 'Top 10 Funds',
            icon: <FundIcon />,
            entries: topFunds.map(i => instToEntry(i, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '顶级项目方 Top 10' : 'Top 10 Projects',
            icon: <ProjectIcon />,
            entries: topProjects.map(i => instToEntry(i, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
          {
            title: isZh ? '顶级交易所 Top 10' : 'Top 10 Exchanges',
            icon: <ExchangeIcon />,
            entries: topExchanges.map(i => instToEntry(i, isZh)),
            loading: leaderboardLoading,
            emptyText: isZh ? '即将上线' : 'Coming soon',
          },
        ]} />

        <h1 style={{ fontSize: tokens.typography.fontSize['3xl'], fontWeight: 800, color: 'var(--color-text-primary)', marginBottom: 8, letterSpacing: '-0.02em' }}>
          {isZh ? '机构' : 'Institutions'}
        </h1>
        <p style={{ fontSize: tokens.typography.fontSize.base, color: 'var(--color-text-tertiary)', marginBottom: 24, lineHeight: tokens.typography.lineHeight.normal }}>
          {isZh ? '发现并评价加密行业中的顶级机构' : 'Discover and rate top institutions in crypto'}
        </p>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          {CATEGORY_FILTERS.map(f => {
            const active = category === f.key
            return (
              <button
                key={f.key}
                onClick={() => setCategory(f.key)}
                onMouseEnter={e => {
                  if (!active) {
                    e.currentTarget.style.borderColor = 'var(--color-brand-muted)'
                    e.currentTarget.style.color = 'var(--color-text-primary)'
                    e.currentTarget.style.background = 'var(--color-bg-hover)'
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                    e.currentTarget.style.color = 'var(--color-text-secondary)'
                    e.currentTarget.style.background = 'var(--color-bg-secondary)'
                  }
                }}
                style={{
                  padding: '8px 20px',
                  borderRadius: tokens.radius.full,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: active ? 700 : 500,
                  border: active ? '1px solid transparent' : '1px solid var(--color-border-primary)',
                  background: active ? tokens.gradient.purpleGold : 'var(--color-bg-secondary)',
                  color: active ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.base}`,
                  boxShadow: active ? tokens.shadow.sm : 'none',
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
              padding: '8px 14px', borderRadius: tokens.radius.full,
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
          <div style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-tertiary)', pointerEvents: 'none', display: 'flex', alignItems: 'center' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={isZh ? '搜索机构...' : 'Search institutions...'}
            onFocus={e => {
              e.currentTarget.style.borderColor = 'var(--color-brand)'
              e.currentTarget.style.boxShadow = `0 0 0 3px var(--color-brand-muted)`
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = 'var(--color-border-primary)'
              e.currentTarget.style.boxShadow = 'none'
            }}
            style={{
              width: '100%', padding: '10px 14px 10px 38px', borderRadius: tokens.radius.xl,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.base, outline: 'none',
              transition: `all ${tokens.transition.base}`,
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 140, borderRadius: tokens.radius.xl }} />
            ))}
          </div>
        ) : institutions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.base }}>
            {isZh ? '暂无数据' : 'No institutions found'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {institutions.map(inst => (
              <InstitutionCard key={inst.id} institution={inst} isZh={isZh} />
            ))}
          </div>
        )}
      </main>
      <MobileBottomNav />
    </div>
  )
}

function InstitutionCard({ institution, isZh }: { institution: Institution; isZh: boolean }) {
  const name = isZh ? (institution.name_zh || institution.name) : institution.name
  const desc = isZh ? (institution.description_zh || institution.description) : institution.description

  return (
    <a
      href={institution.website || '#'}
      target={institution.website ? '_blank' : undefined}
      rel="noopener noreferrer"
      style={{
        display: 'block',
        padding: 22,
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-secondary)',
        textDecoration: 'none',
        transition: `all ${tokens.transition.slow}`,
        boxShadow: tokens.shadow.xs,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--color-brand)'
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
        {institution.logo_url ? (
          <img
            src={institution.logo_url}
            alt=""
            width={44}
            height={44}
            style={{ borderRadius: tokens.radius.xl, objectFit: 'cover', border: '1px solid var(--color-border-primary)', flexShrink: 0 }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: tokens.radius.xl,
            background: tokens.gradient.primarySubtle,
            border: '1px solid var(--color-border-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: tokens.typography.fontSize.md, fontWeight: 700, color: 'var(--color-brand)',
            flexShrink: 0,
          }}>
            {name[0]}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: tokens.typography.fontSize.base, fontWeight: 700, color: 'var(--color-text-primary)', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
            {CATEGORY_FILTERS.find(f => f.key === institution.category)?.[isZh ? 'zh' : 'en'] || institution.category}
          </div>
        </div>
      </div>

      {desc && (
        <p style={{
          fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)', lineHeight: tokens.typography.lineHeight.normal, margin: '0 0 12px',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
        }}>
          {desc}
        </p>
      )}

      {institution.tags && institution.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {institution.tags.slice(0, 3).map(tag => (
            <span key={tag} style={{
              fontSize: tokens.typography.fontSize.xs,
              padding: '3px 10px',
              borderRadius: tokens.radius.full,
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-secondary)',
              fontWeight: 500,
              border: '1px solid var(--color-border-primary)',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {institution.avg_rating != null && institution.avg_rating > 0 ? (
        <StarRating
          rating={institution.avg_rating}
          ratingCount={institution.rating_count}
          size={14}
          readonly
        />
      ) : (
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
          {isZh ? '暂无评分' : 'No ratings yet'}
        </span>
      )}
    </a>
  )
}
