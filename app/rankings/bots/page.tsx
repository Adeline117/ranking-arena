'use client'

/**
 * Web3 Bot Rankings Page
 * Displays TG Bots, AI Agents, and On-chain Vaults in a unified leaderboard.
 */

import { useState, useMemo } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useBotRankings, type BotEntry } from '@/lib/hooks/useBotRankings'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { Box } from '@/app/components/base'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'

type BotCategory = 'all' | 'tg_bot' | 'ai_agent' | 'vault'
type WindowOption = '7D' | '30D' | '90D'

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

function formatLargeNumber(n: number | null): string {
  if (n == null) return 'N/A'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function formatUsers(n: number | null): string {
  if (n == null) return 'N/A'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return n.toString()
}

function formatPercent(n: number | null): string {
  if (n == null) return '--'
  return `${n.toFixed(1)}%`
}

/** Chain badge */
function ChainBadge({ chain }: { chain: string | null }) {
  if (!chain) return null
  const color = CHAIN_COLORS[chain] || 'var(--color-text-tertiary)'
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: tokens.radius.sm,
      fontSize: 10,
      fontWeight: 600,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      color,
      textTransform: 'capitalize',
      letterSpacing: '0.3px',
    }}>
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
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: tokens.radius.sm,
      fontSize: 10,
      fontWeight: 600,
      background: `color-mix(in srgb, ${cfg.color} 15%, transparent)`,
      color: cfg.color,
    }}>
      {t(cfg.key)}
    </span>
  )
}

/** Score badge */
function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <span style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>--</span>
  const hex = getScoreColorHex(score)
  const cssColor = getScoreColor(score)
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '3px 10px',
      borderRadius: tokens.radius.md,
      fontSize: 13,
      fontWeight: 700,
      fontFamily: tokens.typography.fontFamily.mono.join(','),
      background: `linear-gradient(135deg, ${hex}25, ${hex}10)`,
      color: cssColor,
      border: `1px solid ${hex}45`,
      minWidth: 56,
    }}>
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
    <div style={{
      width: 36, height: 36, minWidth: 36, borderRadius: '50%',
      background: colors[bot.category] || colors.strategy,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--color-on-accent)', fontSize: 14, fontWeight: 700,
      border: '2px solid var(--color-border-primary)',
    }}>
      {initial}
    </div>
  )
}

function BotRow({ bot }: { bot: BotEntry }) {
  const m = bot.metrics
  return (
    <Link
      href={`/bot/${bot.slug}`}
      className="grid gap-2 px-4 items-center border-b last:border-b-0 ranking-row-hover"
      style={{
        gridTemplateColumns: '40px 1fr 80px 70px 70px 70px 64px',
        borderColor: `${tokens.colors.border.primary}30`,
        textDecoration: 'none',
        transition: `all ${tokens.transition.base}`,
        minHeight: 56, paddingTop: 10, paddingBottom: 10,
        background: bot.rank % 2 === 0 ? 'var(--overlay-hover, rgba(255,255,255,0.02))' : undefined,
      }}
    >
      {/* Rank */}
      <div className="text-sm font-medium" style={{ color: 'var(--color-text-secondary)', textAlign: 'center' }}>
        {bot.rank <= 3 ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: '50%', fontSize: 12, fontWeight: 700,
            background: bot.rank === 1
              ? 'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))'
              : bot.rank === 2
              ? 'linear-gradient(135deg, var(--color-medal-silver), #A0A0A0)'
              : 'linear-gradient(135deg, var(--color-medal-bronze), #A0522D)',
            color: bot.rank === 1 ? 'var(--color-bg-primary)' : 'var(--color-text-primary)',
          }}>
            {bot.rank}
          </span>
        ) : (
          <span className="tabular-nums" style={{ fontSize: 13 }}>{bot.rank}</span>
        )}
      </div>

      {/* Bot info */}
      <div className="flex items-center gap-3 min-w-0">
        <BotAvatar bot={bot} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-primary)', lineHeight: 1.3 }}>
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
      <div className="text-right text-sm tabular-nums" style={{ color: m.tvl != null ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', fontWeight: 500 }} title={m.tvl == null ? 'Data not yet available' : undefined}>
        {formatLargeNumber(m.tvl)}
      </div>

      {/* Users */}
      <div className="text-right text-sm tabular-nums" style={{ color: m.unique_users != null ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)' }} title={m.unique_users == null ? 'Data not yet available' : undefined}>
        {formatUsers(m.unique_users)}
      </div>

      {/* APY/ROI */}
      <div className="text-right text-sm font-bold tabular-nums" style={{
        color: (m.apy ?? m.roi ?? 0) >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)',
      }}>
        {m.apy != null ? formatPercent(m.apy) : m.roi != null ? formatPercent(m.roi) : '—'}
      </div>

      {/* Volume */}
      <div className="text-right text-sm tabular-nums col-volume" style={{ color: 'var(--color-text-secondary)' }}>
        {formatLargeNumber(m.total_volume)}
      </div>

      {/* Score */}
      <div className="text-right">
        <ScoreBadge score={m.arena_score} />
      </div>
    </Link>
  )
}

function BotsContent() {
  const { t } = useLanguage()
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const activeWindow = (searchParams.get('window') as WindowOption) || '90D'
  const activeCategory = (searchParams.get('category') as BotCategory) || 'all'

  const { data, error, isLoading } = useBotRankings({
    window: activeWindow,
    category: activeCategory === 'all' ? undefined : activeCategory,
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

  const [searchQuery, setSearchQuery] = useState('')
  const filteredBots = useMemo(() => {
    if (!data?.bots) return []
    if (!searchQuery.trim()) return data.bots
    const q = searchQuery.toLowerCase()
    return data.bots.filter(b =>
      b.name.toLowerCase().includes(q) ||
      (b.token_symbol && b.token_symbol.toLowerCase().includes(q))
    )
  }, [data, searchQuery])

  return (
    <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>

      <div className="feed-main-content max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: tokens.spacing[4] }}>
          <div>
            <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: tokens.typography.fontWeight.black, letterSpacing: '-0.3px' }}>
              {t('botsTitle')}
            </h1>
            <p style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
              {t('botsSubtitle')}
            </p>
          </div>
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
        </div>

        {/* Time window */}
        <div className="flex flex-wrap gap-2 mb-4">
          {(['7D', '30D', '90D'] as WindowOption[]).map(w => (
            <button
              key={w}
              onClick={() => handleWindowChange(w)}
              className="ranking-filter-btn touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeWindow === w ? 700 : 500,
                background: activeWindow === w ? tokens.gradient.purpleGold : 'var(--glass-bg-light, rgba(255,255,255,0.04))',
                color: activeWindow === w ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                border: activeWindow === w ? 'none' : `1px solid var(--color-border-primary)`,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                outline: 'none',
              }}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div className="flex flex-wrap gap-2 mb-4">
          {(['all', 'tg_bot', 'ai_agent', 'vault'] as BotCategory[]).map(cat => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className="ranking-filter-btn touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeCategory === cat ? 700 : 500,
                background: activeCategory === cat ? tokens.gradient.purpleGold : 'var(--glass-bg-light, rgba(255,255,255,0.04))',
                color: activeCategory === cat ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
                border: activeCategory === cat ? 'none' : `1px solid var(--color-border-primary)`,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                outline: 'none',
              }}
            >
              {t(CATEGORY_LABEL_KEYS[cat])}
            </button>
          ))}
        </div>

        {/* Search */}
        <div style={{ position: 'relative', marginBottom: tokens.spacing[4] }}>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t('botsSearchPlaceholder')}
            style={{
              width: '100%', padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid var(--color-border-primary)`,
              background: 'var(--glass-bg-light, rgba(255,255,255,0.04))',
              color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm,
              outline: 'none',
            }}
          />
        </div>

        {/* Table */}
        <DataStateWrapper
          isLoading={isLoading}
          error={error}
          isEmpty={filteredBots.length === 0 && !isLoading}
          emptyMessage={t('botsNoData')}
          loadingComponent={<RankingSkeleton />}
        >
          <div className="rounded-xl overflow-hidden" style={{
            background: 'var(--glass-bg-secondary, rgba(255,255,255,0.03))',
            border: `1px solid var(--color-border-primary)`,
            boxShadow: tokens.shadow.md,
          }}>
            {/* Header row */}
            <div
              className="grid gap-2 px-4 py-3 text-xs font-semibold border-b"
              style={{
                gridTemplateColumns: '40px 1fr 80px 70px 70px 70px 64px',
                color: 'var(--color-text-tertiary)',
                borderColor: 'var(--color-border-primary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontSize: 11,
                position: 'sticky', top: 0, zIndex: 20,
                background: 'var(--color-bg-secondary, var(--color-bg-primary))',
              }}
            >
              <div style={{ textAlign: 'center' }}>#</div>
              <div>{t('botsBot')}</div>
              <div style={{ textAlign: 'right' }}>TVL</div>
              <div style={{ textAlign: 'right' }}>{t('botsUsers')}</div>
              <div style={{ textAlign: 'right' }}>APY/ROI</div>
              <div className="col-volume" style={{ textAlign: 'right' }}>{t('botsVolume')}</div>
              <div style={{ textAlign: 'right' }}>Score</div>
            </div>

            {filteredBots.map(bot => (
              <BotRow key={bot.id} bot={bot} />
            ))}

            <div className="px-4 py-3 text-xs text-center border-t" style={{ color: 'var(--color-text-tertiary)', borderColor: 'var(--color-border-primary)' }}>
              {t('botsTotalCount').replace('{count}', String(filteredBots.length))}
            </div>
          </div>
        </DataStateWrapper>
      </div>
      <MobileBottomNav />
    </Box>
  )
}


export default function BotRankingsPage() {
  return (
    <ErrorBoundary pageType="rankings">
      <Suspense fallback={
        <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>

          <div className="max-w-5xl mx-auto px-4 py-6"><RankingSkeleton /></div>
        </Box>
      }>
        <BotsContent />
      </Suspense>
    </ErrorBoundary>
  )
}
