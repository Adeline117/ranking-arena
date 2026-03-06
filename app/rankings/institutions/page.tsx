'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards, { type LeaderboardEntry } from '@/app/components/ui/TopLeaderboards'

// MobileBottomNav is rendered by root layout — do not duplicate here

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
  { key: 'all', labelKey: 'instCatAll' },
  { key: 'exchange', labelKey: 'instCatExchange' },
  { key: 'cex', labelKey: 'instCatCex' },
  { key: 'dex', labelKey: 'instCatDex' },
  { key: 'derivatives', labelKey: 'instCatDerivatives' },
  { key: 'dex-aggregator', labelKey: 'instCatDexAggregator' },
  { key: 'otc', labelKey: 'instCatOtc' },
  { key: 'fund', labelKey: 'instCatFund' },
  { key: 'crypto-vc', labelKey: 'instCatCryptoVc' },
  { key: 'traditional-vc', labelKey: 'instCatTraditionalVc' },
  { key: 'hedge-fund', labelKey: 'instCatHedgeFund' },
  { key: 'family-office', labelKey: 'instCatFamilyOffice' },
  { key: 'trading-firm', labelKey: 'instCatTradingFirm' },
  { key: 'dao-treasury', labelKey: 'instCatDaoTreasury' },
  { key: 'accelerator', labelKey: 'instCatAccelerator' },
  { key: 'l1', labelKey: 'instCatL1' },
  { key: 'l2', labelKey: 'instCatL2' },
  { key: 'project', labelKey: 'instCatProject' },
  { key: 'defi', labelKey: 'instCatDefi', isGroup: true },
  { key: 'infrastructure', labelKey: 'instCatInfrastructure' },
  { key: 'services', labelKey: 'instCatServices', isGroup: true },
  { key: 'media', labelKey: 'instCatMedia', isGroup: true },
] as const

// Map from category filter key to its labelKey for reverse lookup in InstitutionCard
const INST_CATEGORY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  CATEGORY_FILTERS.map(f => [f.key, f.labelKey])
)

// Category groups for combined filters
const CATEGORY_GROUPS: Record<string, string[]> = {
  defi: ['defi-lending', 'defi-stablecoin', 'liquid-staking', 'restaking', 'defi-yield', 'defi-cdp', 'defi-derivatives', 'defi-insurance'],
  services: ['custody', 'compliance', 'audit', 'market-maker', 'prime-broker', 'banking', 'legal', 'accounting', 'insurance-provider', 'payroll', 'fund-admin'],
  media: ['media', 'podcast', 'research', 'data-provider', 'newsletter', 'education'],
}

const SORT_OPTIONS = [
  { key: 'rating', labelKey: 'instSortRating' },
  { key: 'newest', labelKey: 'instSortNewest' },
  { key: 'reviews', labelKey: 'instSortReviews' },
] as const

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

function instToEntry(inst: Institution, lang: 'zh' | 'en'): LeaderboardEntry {
  return {
    id: inst.id,
    name: lang === 'zh' ? (inst.name_zh || inst.name) : inst.name,
    rating: inst.avg_rating,
    logoUrl: inst.logo_url,
    href: inst.website,
  }
}


export default function InstitutionsPage() {
  const { language, t } = useLanguage()
  const [institutions, setInstitutions] = useState<Institution[]>([])
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
  const [topFunds, setTopFunds] = useState<Institution[]>([])
  const [topProjects, setTopProjects] = useState<Institution[]>([])
  const [topExchanges, setTopExchanges] = useState<Institution[]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  // Fetch leaderboard data once
  useEffect(() => {
    async function fetchLeaderboards() {
      setLeaderboardLoading(true)
      try {
        const fetchTopMulti = async (cats: string[]) => {
          const { data } = await supabase
            .from('institutions')
            .select('id, name, name_zh, category, logo_url, website, description, description_zh, avg_rating, rating_count, tags')
            .eq('is_active', true)
            .in('category', cats)
            .order('avg_rating', { ascending: false, nullsFirst: false })
            .limit(10)
          return data || []
        }
        const [funds, projects, exchanges] = await Promise.all([
          fetchTopMulti(['fund', 'crypto-vc', 'traditional-vc', 'hedge-fund', 'trading-firm', 'family-office', 'accelerator', 'dao-treasury']),
          fetchTopMulti(['project', 'l1', 'l2', ...CATEGORY_GROUPS.defi]),
          fetchTopMulti(['exchange', 'cex', 'dex', 'derivatives', 'dex-aggregator', 'otc']),
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

  // Fetch counts per category for filter badges
  useEffect(() => {
    async function fetchCounts() {
      try {
        const { data } = await supabase
          .from('institutions')
          .select('category')
          .eq('is_active', true)
        if (!data) return
        const counts: Record<string, number> = { all: data.length }
        data.forEach(row => {
          const cat = row.category as string
          counts[cat] = (counts[cat] || 0) + 1
        })
        // Compute group counts
        Object.entries(CATEGORY_GROUPS).forEach(([groupKey, cats]) => {
          counts[groupKey] = cats.reduce((sum, c) => sum + (counts[c] || 0), 0)
        })
        // exchange group: sum cex + dex + derivatives + dex-aggregator + otc + exchange
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
        .from('institutions')
        .select('id, name, name_zh, category, logo_url, website, description, description_zh, avg_rating, rating_count, tags')
        .eq('is_active', true)

      if (category !== 'all') {
        const groupCats = CATEGORY_GROUPS[category]
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
      setInstitutions(data || [])
    } catch {
      setError(t('failedToLoadRetry'))
    } finally {
      setLoading(false)
    }
  }, [category, sort, debouncedSearch, t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 100px' }}>

        {/* Top Leaderboards */}
        <TopLeaderboards columns={[
          {
            title: t('top10Funds'),
            icon: <FundIcon />,
            entries: topFunds.map(i => instToEntry(i, language)),
            loading: leaderboardLoading,
            emptyText: t('comingSoon'),
          },
          {
            title: t('top10Projects'),
            icon: <ProjectIcon />,
            entries: topProjects.map(i => instToEntry(i, language)),
            loading: leaderboardLoading,
            emptyText: t('comingSoon'),
          },
          {
            title: t('top10Exchanges'),
            icon: <ExchangeIcon />,
            entries: topExchanges.map(i => instToEntry(i, language)),
            loading: leaderboardLoading,
            emptyText: t('comingSoon'),
          },
        ]} />

        <h1 style={{ fontSize: tokens.typography.fontSize['3xl'], fontWeight: 800, color: 'var(--color-text-primary)', marginBottom: 8, letterSpacing: '-0.02em' }}>
          {t('institutions')}
        </h1>
        <p style={{ fontSize: tokens.typography.fontSize.base, color: 'var(--color-text-tertiary)', marginBottom: 24, lineHeight: tokens.typography.lineHeight.normal }}>
          {t('discoverRateInstitutions')}
        </p>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          {CATEGORY_FILTERS.map(f => {
            const active = category === f.key
            const count = categoryCounts[f.key]
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '9px 18px',
                  borderRadius: tokens.radius.full,
                  fontSize: tokens.typography.fontSize.base,
                  fontWeight: active ? 700 : 500,
                  border: active ? '1px solid transparent' : '1px solid var(--color-border-primary)',
                  background: active ? tokens.gradient.purpleGold : 'var(--color-bg-secondary)',
                  color: active ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.base}`,
                  boxShadow: active ? tokens.shadow.md : 'none',
                  letterSpacing: '0.01em',
                }}
              >
                {t(f.labelKey)}
                {count != null && count > 0 && (
                  <span style={{
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: tokens.radius.full,
                    background: active ? 'var(--glass-bg-heavy)' : 'var(--color-accent-primary-12)',
                    color: active ? 'var(--color-text-primary)' : 'var(--color-accent-primary)',
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
              <option key={opt.key} value={opt.key}>{t(opt.labelKey)}</option>
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
            placeholder={t('searchInstitutions')}
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
              {t('retry')}
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
            {t('noInstitutionsFound')}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {institutions.map(inst => (
              <InstitutionCard key={inst.id} institution={inst} language={language} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function InstitutionCard({ institution, language }: { institution: Institution; language: 'zh' | 'en' }) {
  const { t } = useLanguage()
  const name = language === 'zh' ? (institution.name_zh || institution.name) : institution.name
  const desc = language === 'zh' ? (institution.description_zh || institution.description) : institution.description

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
            alt={`${institution.name} logo`}
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
            {INST_CATEGORY_LABEL_MAP[institution.category] ? t(INST_CATEGORY_LABEL_MAP[institution.category]) : institution.category}
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
          {t('instNoRatingsYet')}
        </span>
      )}
    </a>
  )
}
