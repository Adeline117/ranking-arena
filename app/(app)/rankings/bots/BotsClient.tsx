'use client'

/**
 * Web3 Bot Rankings Client Component
 * Receives SSR initial data as props for instant render, then hydrates with SWR.
 *
 * Brought up to the shipped homepage leaderboard bar (RankingTable) standard:
 *  - real table semantics (role=table/row/columnheader/cell)
 *  - client-sortable column headers (aria-sort + native button keyboard)
 *  - colorblind-safe APY/ROI deltas via <Metric showArrow> (▲/▼ + color)
 *  - filter pills as role=tab/aria-selected with facet counts + focus-visible ring
 *  - sticky header offset by --top-nav-height, mobile card fallback at ≤720px
 *  - medal/score colors from design tokens (rankColors / getScoreColorInfo)
 */

import { useState, useMemo, useCallback, useRef } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Suspense } from 'react'
import { tokens, alpha, rankColors } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useBotRankings, type BotEntry, type BotRankingsResponse } from '@/lib/hooks/useBotRankings'
// MobileBottomNav is rendered by root layout — do not duplicate here
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import PageHeader from '@/app/components/ui/PageHeader'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { Box } from '@/app/components/base'
import Metric from '@/app/components/ui/Metric'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { useTabsA11y } from '@/lib/hooks/useTabsA11y'

type BotCategory = 'all' | 'tg_bot' | 'ai_agent' | 'vault'
type WindowOption = '7D' | '30D' | '90D'
/** Client-sortable metric columns. `null` = default (server rank) order. */
type SortKey = 'tvl' | 'unique_users' | 'apy' | 'total_volume' | 'arena_score'
type SortState = { key: SortKey | null; dir: 'asc' | 'desc' }

const CATEGORY_LABEL_KEYS: Record<BotCategory, string> = {
  all: 'botsCategoryAll',
  tg_bot: 'botsCategoryTgBot',
  ai_agent: 'botsCategoryAiAgent',
  vault: 'botsCategoryVault',
}

const CHAIN_COLORS: Record<string, string> = {
  solana: 'var(--color-chart-violet)',
  ethereum: 'var(--color-chart-blue)',
  base: 'var(--color-chart-indigo)',
  arbitrum: 'var(--color-chart-blue)',
  multi: 'var(--color-chart-teal)',
}

/**
 * Scoped CSS for the bots table. Owns the grid template (so the ≤720px media
 * query can restack rows into cards without inline-style !important fights) and
 * the sort-button reset. Desktop layout is unchanged from the previous inline
 * grid. The card breakpoint (720px) is above the desktop grid's intrinsic min
 * width (~662px incl. padding) so the row grid never clips inside the
 * overflow-hidden container between breakpoints.
 */
const BOTS_TABLE_CSS = `
.bots-grid{display:grid;grid-template-columns:40px minmax(150px,1fr) 88px 72px 84px 80px 68px;gap:8px;align-items:center;}
.bots-sort-btn{background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:3px;font:inherit;color:inherit;padding:0;width:100%;}
.bots-sort-btn:hover{color:var(--color-text-secondary);}
@media (max-width:720px){
  .bots-header{display:none!important;}
  .bots-row.bots-grid{grid-template-columns:repeat(2,1fr);row-gap:8px;column-gap:12px;padding-top:14px;padding-bottom:14px;position:relative;}
  .bots-row .bots-cell-name{grid-column:1 / -1;}
  .bots-row .bots-cell-rank{position:absolute;top:12px;right:16px;text-align:right;}
  .bots-row .bots-cell[data-label]{text-align:left;}
  .bots-row .bots-cell[data-label]::before{content:attr(data-label);display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--color-text-tertiary);margin-bottom:2px;}
}
`

function formatLargeNumber(n: number | null): string {
  if (n == null) return NULL_DISPLAY
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function formatUsers(n: number | null): string {
  if (n == null) return NULL_DISPLAY
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toString()
}

function formatPercent(n: number | null): string {
  if (n == null) return NULL_DISPLAY
  return `${n.toFixed(1)}%`
}

/** Medal gradient derived from rankColors tokens (no hardcoded hex). */
function medalGradient(rank: number): string {
  const base = rank === 1 ? rankColors.gold : rank === 2 ? rankColors.silver : rankColors.bronze
  return `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 65%, #000))`
}

/** Sort accessor — single source of truth for the client sort comparator. */
function botSortValue(bot: BotEntry, key: SortKey): number | null {
  const m = bot.metrics
  switch (key) {
    case 'tvl':
      return m.tvl
    case 'unique_users':
      return m.unique_users
    case 'apy':
      return m.apy ?? m.roi
    case 'total_volume':
      return m.total_volume
    case 'arena_score':
      return m.arena_score
  }
}

/** Chain badge */
function ChainBadge({ chain }: { chain: string | null }) {
  if (!chain) return null
  const color = CHAIN_COLORS[chain] || 'var(--color-text-tertiary)'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: tokens.radius.sm,
        fontSize: 10,
        fontWeight: 600,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
        textTransform: 'capitalize',
        letterSpacing: '0.3px',
      }}
    >
      {chain}
    </span>
  )
}

/** Category tag */
function CategoryTag({ category }: { category: string }) {
  const { t } = useLanguage()
  const TAG_KEYS: Record<string, { key: string; color: string }> = {
    tg_bot: { key: 'botsTagTgBot', color: 'var(--color-chart-amber)' },
    ai_agent: { key: 'botsTagAiAgent', color: 'var(--color-chart-violet)' },
    vault: { key: 'botsTagVault', color: 'var(--color-chart-teal)' },
    strategy: { key: 'botsTagStrategy', color: 'var(--color-chart-blue)' },
  }
  const cfg = TAG_KEYS[category] || { key: category, color: 'var(--color-text-tertiary)' }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: tokens.radius.sm,
        fontSize: 10,
        fontWeight: 600,
        background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
        color: cfg.color,
      }}
    >
      {t(cfg.key)}
    </span>
  )
}

/** Score badge — colors derived from getScoreColorInfo (shared tier source). */
function ScoreBadge({ score }: { score: number | null }) {
  if (score == null)
    return <span style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>--</span>
  const info = getScoreColorInfo(score)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3px 10px',
        borderRadius: tokens.radius.md,
        fontSize: 13,
        fontWeight: 700,
        fontFamily: tokens.typography.fontFamily.mono.join(','),
        background: info.bgGradient,
        color: info.color,
        border: `1px solid ${info.borderColor}`,
        minWidth: 56,
      }}
    >
      {score.toFixed(1)}
    </span>
  )
}

/** Bot avatar fallback */
function BotAvatar({ bot }: { bot: BotEntry }) {
  const initial = bot.name.charAt(0).toUpperCase()
  const colors: Record<string, string> = {
    tg_bot: 'linear-gradient(135deg, var(--color-chart-amber), var(--color-chart-orange))',
    ai_agent: 'linear-gradient(135deg, var(--color-chart-violet), var(--color-chart-indigo))',
    vault: 'linear-gradient(135deg, var(--color-chart-teal), var(--color-chart-blue))',
    strategy: 'linear-gradient(135deg, var(--color-chart-blue), var(--color-chart-indigo))',
  }
  return (
    <div
      style={{
        width: 36,
        height: 36,
        minWidth: 36,
        borderRadius: '50%',
        background: colors[bot.category] || colors.strategy,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-on-accent)',
        fontSize: 14,
        fontWeight: 700,
        border: '2px solid var(--color-border-primary)',
      }}
    >
      {initial}
    </div>
  )
}

/** Sortable column header — a real <button role=columnheader> (native Enter/Space)
 *  carrying aria-sort. Sort glyph is aria-hidden (color is not the only cue). */
function SortHeader({
  label,
  columnKey,
  sort,
  onSort,
  align = 'right',
}: {
  label: string
  columnKey: SortKey
  sort: SortState
  onSort: (key: SortKey) => void
  align?: 'right' | 'center'
}) {
  const active = sort.key === columnKey
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      aria-label={`${label} — sort`}
      onClick={() => onSort(columnKey)}
      className="bots-sort-btn"
      style={{
        justifyContent: align === 'center' ? 'center' : 'flex-end',
        color: active ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      <span>{label}</span>
      <span aria-hidden="true" style={{ fontSize: 9, opacity: active ? 1 : 0.4 }}>
        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </button>
  )
}

function BotRow({ bot, index }: { bot: BotEntry; index: number }) {
  const { t } = useLanguage()
  const m = bot.metrics
  const apyVal = m.apy != null ? m.apy : m.roi
  return (
    <Link
      href={`/bot/${bot.slug}`}
      role="row"
      aria-label={`#${bot.rank} ${bot.name}`}
      className="bots-grid bots-row px-4 items-center border-b last:border-b-0 ranking-row-hover"
      style={{
        borderColor: `${alpha(tokens.colors.border.primary, 19)}`,
        textDecoration: 'none',
        transition: `all ${tokens.transition.base}`,
        minHeight: 56,
        paddingTop: 10,
        paddingBottom: 10,
        background: index % 2 === 1 ? 'var(--overlay-hover, rgba(255,255,255,0.02))' : undefined,
      }}
    >
      {/* Rank */}
      <div
        role="cell"
        className="text-sm font-medium bots-cell bots-cell-rank"
        style={{ color: 'var(--color-text-secondary)', textAlign: 'center' }}
      >
        {bot.rank <= 3 ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: '50%',
              fontSize: 12,
              fontWeight: 700,
              background: medalGradient(bot.rank),
              color: bot.rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-text-primary)',
            }}
          >
            {bot.rank}
          </span>
        ) : (
          <span className="tabular-nums" style={{ fontSize: 13 }}>
            {bot.rank}
          </span>
        )}
      </div>

      {/* Bot info */}
      <div role="cell" className="flex items-center gap-3 min-w-0 bots-cell bots-cell-name">
        <BotAvatar bot={bot} />
        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-semibold truncate"
            style={{ color: 'var(--color-text-primary)', lineHeight: 1.3 }}
          >
            {bot.name}
          </div>
          <div className="flex items-center gap-1.5" style={{ marginTop: 2 }}>
            <CategoryTag category={bot.category} />
            <ChainBadge chain={bot.chain} />
            {bot.token_symbol && (
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
                ${bot.token_symbol}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* TVL */}
      <div
        role="cell"
        data-label="TVL"
        className="text-right text-sm tabular-nums bots-cell"
        style={{
          color: m.tvl != null ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
          fontWeight: 500,
        }}
        title={m.tvl == null ? 'Data not yet available' : undefined}
      >
        {formatLargeNumber(m.tvl)}
      </div>

      {/* Users */}
      <div
        role="cell"
        data-label={t('botsUsers')}
        className="text-right text-sm tabular-nums bots-cell"
        style={{
          color:
            m.unique_users != null ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
        }}
        title={m.unique_users == null ? 'Data not yet available' : undefined}
      >
        {formatUsers(m.unique_users)}
      </div>

      {/* APY/ROI — colorblind-safe via Metric (▲/▼ arrow + sign color) */}
      <div role="cell" data-label="APY/ROI" className="text-right bots-cell">
        <Metric
          value={apyVal}
          display={apyVal != null ? formatPercent(apyVal) : undefined}
          colorBySign
          showArrow
          size="sm"
          as="span"
        />
      </div>

      {/* Volume */}
      <div
        role="cell"
        data-label={t('botsVolume')}
        className="text-right text-sm tabular-nums bots-cell col-volume"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        {formatLargeNumber(m.total_volume)}
      </div>

      {/* Score */}
      <div role="cell" data-label="Score" className="text-right bots-cell">
        <ScoreBadge score={m.arena_score} />
      </div>
    </Link>
  )
}

interface BotsClientProps {
  initialBots: BotRankingsResponse | null
}

function BotsContent({ initialBots }: BotsClientProps) {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const activeWindow = (searchParams.get('window') as WindowOption) || '90D'
  const activeCategory = (searchParams.get('category') as BotCategory) || 'all'

  // Use SSR data as fallbackData for the default 90D/all view for instant render
  const isDefaultView = activeWindow === '90D' && activeCategory === 'all'

  const { data, error, isLoading } = useBotRankings({
    window: activeWindow,
    category: activeCategory === 'all' ? undefined : activeCategory,
    fallbackData: isDefaultView && initialBots ? initialBots : undefined,
  })

  const handleWindowChange = (w: WindowOption) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('window', w)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const handleCategoryChange = (cat: BotCategory) => {
    const params = new URLSearchParams(searchParams.toString())
    if (cat === 'all') params.delete('category')
    else params.set('category', cat)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  // B2 tabs a11y: both filter tablists control the single results region.
  const windowTabsA11y = useTabsA11y({
    tabs: ['7D', '30D', '90D'] as const,
    active: activeWindow,
    onChange: handleWindowChange,
    idPrefix: 'bots-window',
    sharedPanelId: 'bots-results',
  })
  const categoryTabsA11y = useTabsA11y({
    tabs: ['all', 'tg_bot', 'ai_agent', 'vault'] as const,
    active: activeCategory,
    onChange: handleCategoryChange,
    idPrefix: 'bots-cat',
    sharedPanelId: 'bots-results',
  })

  const [searchQuery, setSearchQueryRaw] = useState(() => searchParams.get('q') || '')
  const searchSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setSearchQuery = useCallback(
    (q: string) => {
      setSearchQueryRaw(q)
      // Sync search to URL (debounced 300ms)
      if (searchSyncRef.current) clearTimeout(searchSyncRef.current)
      searchSyncRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams.toString())
        if (q.trim()) params.set('q', q.trim())
        else params.delete('q')
        router.replace(`${pathname}?${params.toString()}`, { scroll: false })
      }, 300)
    },
    [searchParams, router, pathname]
  )

  // Client-side column sort (default: server rank order when key === null).
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'desc' })
  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }
    )
  }, [])

  const filteredBots = useMemo(() => {
    if (!data?.bots) return []
    if (!searchQuery.trim()) return data.bots
    const q = searchQuery.toLowerCase()
    return data.bots.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.token_symbol && b.token_symbol.toLowerCase().includes(q))
    )
  }, [data, searchQuery])

  const sortedBots = useMemo(() => {
    if (!sort.key) return filteredBots
    const key = sort.key
    const dir = sort.dir
    return [...filteredBots].sort((a, b) => {
      const av = botSortValue(a, key)
      const bv = botSortValue(b, key)
      // Nulls always sort last regardless of direction.
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return dir === 'desc' ? bv - av : av - bv
    })
  }, [filteredBots, sort])

  // Facet counts for the category pills, derived from loaded data. Accurate for
  // the "all" view; cached in a ref so switching into a filtered view (which only
  // loads that one category) still shows meaningful per-category numbers. Counts
  // reflect the loaded page (API default 50/category), not the global total.
  const facetCountsRef = useRef<Record<BotCategory, number>>({
    all: 0,
    tg_bot: 0,
    ai_agent: 0,
    vault: 0,
  })
  const facetCounts = useMemo(() => {
    if (activeCategory === 'all' && data?.bots) {
      const c: Record<BotCategory, number> = {
        all: data.total_count ?? data.bots.length,
        tg_bot: 0,
        ai_agent: 0,
        vault: 0,
      }
      for (const b of data.bots) {
        if (b.category === 'tg_bot' || b.category === 'ai_agent' || b.category === 'vault') {
          c[b.category] += 1
        }
      }
      facetCountsRef.current = c
      return c
    }
    return facetCountsRef.current
  }, [activeCategory, data])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg-primary)',
        color: 'var(--color-text-primary)',
      }}
    >
      <style>{BOTS_TABLE_CSS}</style>
      <div className="feed-main-content max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        {/* Header */}
        <PageHeader
          title={t('botsTitle')}
          subtitle={t('botsSubtitle')}
          compact
          actions={
            <Link
              href="/rankings"
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: 'var(--color-accent-brand)',
                textDecoration: 'none',
              }}
            >
              {t('botsBackToTraders')}
            </Link>
          }
        />

        {/* Time window */}
        <div
          {...windowTabsA11y.getTabListProps()}
          aria-label={t('botsTitle')}
          className="flex flex-wrap gap-2 mb-4"
        >
          {(['7D', '30D', '90D'] as WindowOption[]).map((w) => (
            <button
              key={w}
              {...windowTabsA11y.getTabProps(w)}
              onClick={() => handleWindowChange(w)}
              className="ranking-filter-btn touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeWindow === w ? 700 : 500,
                background:
                  activeWindow === w
                    ? tokens.gradient.purpleGold
                    : 'var(--glass-bg-light, rgba(255,255,255,0.04))',
                color:
                  activeWindow === w ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                border: activeWindow === w ? 'none' : `1px solid var(--color-border-primary)`,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div
          {...categoryTabsA11y.getTabListProps()}
          aria-label={t('botsCategoryAll')}
          className="flex flex-wrap gap-2 mb-4"
        >
          {(['all', 'tg_bot', 'ai_agent', 'vault'] as BotCategory[]).map((cat) => {
            const count = facetCounts[cat]
            return (
              <button
                key={cat}
                {...categoryTabsA11y.getTabProps(cat)}
                onClick={() => handleCategoryChange(cat)}
                className="ranking-filter-btn touch-target"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                  minHeight: 44,
                  borderRadius: tokens.radius.lg,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: activeCategory === cat ? 700 : 500,
                  background:
                    activeCategory === cat
                      ? tokens.gradient.purpleGold
                      : 'var(--glass-bg-light, rgba(255,255,255,0.04))',
                  color:
                    activeCategory === cat
                      ? 'var(--color-on-accent)'
                      : 'var(--color-text-secondary)',
                  border: activeCategory === cat ? 'none' : `1px solid var(--color-border-primary)`,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {t(CATEGORY_LABEL_KEYS[cat])}
                {count > 0 && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      opacity: 0.75,
                      borderRadius: tokens.radius.full,
                      padding: '1px 6px',
                      background:
                        activeCategory === cat
                          ? 'rgba(255,255,255,0.2)'
                          : 'var(--color-bg-tertiary, rgba(255,255,255,0.06))',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div style={{ position: 'relative', marginBottom: tokens.spacing[4] }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('botsSearchPlaceholder')}
            aria-label={t('botsSearchPlaceholder')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid var(--color-border-primary)`,
              background: 'var(--glass-bg-light, rgba(255,255,255,0.04))',
              color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
        </div>

        {/* Table */}
        <DataStateWrapper
          isLoading={isLoading}
          error={error}
          isEmpty={sortedBots.length === 0 && !isLoading}
          emptyMessage={t('botsNoData')}
          loadingComponent={<RankingSkeleton />}
        >
          <div
            {...windowTabsA11y.getSharedPanelProps()}
            className="rounded-xl overflow-hidden"
            style={{
              background: 'var(--glass-bg-secondary, rgba(255,255,255,0.03))',
              border: `1px solid var(--color-border-primary)`,
              boxShadow: tokens.shadow.md,
            }}
          >
            <div role="table" aria-label={t('botsTitle')}>
              {/* Header row */}
              <div
                role="row"
                className="bots-grid bots-header px-4 py-3 text-xs font-semibold border-b"
                style={{
                  color: 'var(--color-text-tertiary)',
                  borderColor: 'var(--color-border-primary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  fontSize: 11,
                  position: 'sticky',
                  top: 'var(--top-nav-height, 56px)',
                  zIndex: tokens.zIndex.sticky,
                  background: 'var(--color-bg-secondary, var(--color-bg-primary))',
                }}
              >
                <div role="columnheader" style={{ textAlign: 'center' }}>
                  #
                </div>
                <div role="columnheader">{t('botsBot')}</div>
                <SortHeader label="TVL" columnKey="tvl" sort={sort} onSort={handleSort} />
                <SortHeader
                  label={t('botsUsers')}
                  columnKey="unique_users"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortHeader label="APY/ROI" columnKey="apy" sort={sort} onSort={handleSort} />
                <SortHeader
                  label={t('botsVolume')}
                  columnKey="total_volume"
                  sort={sort}
                  onSort={handleSort}
                />
                <SortHeader label="Score" columnKey="arena_score" sort={sort} onSort={handleSort} />
              </div>

              {sortedBots.map((bot, idx) => (
                <BotRow key={bot.id} bot={bot} index={idx} />
              ))}
            </div>

            <div
              className="px-4 py-3 text-xs text-center border-t"
              style={{
                color: 'var(--color-text-tertiary)',
                borderColor: 'var(--color-border-primary)',
              }}
            >
              {t('botsTotalCount').replace('{count}', String(sortedBots.length))}
            </div>
          </div>
        </DataStateWrapper>
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}

export default function BotsClient({ initialBots }: BotsClientProps) {
  return (
    <ErrorBoundary pageType="rankings">
      <Suspense
        fallback={
          <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
            <div className="max-w-5xl mx-auto px-4 py-6">
              <RankingSkeleton />
            </div>
          </Box>
        }
      >
        <BotsContent initialBots={initialBots} />
      </Suspense>
    </ErrorBoundary>
  )
}
