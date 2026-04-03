'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { fetcher } from '@/lib/hooks/useSWR'
import { tokens } from '@/lib/design-tokens'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLinkedAccounts } from '@/lib/hooks/useLinkedAccounts'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import TopNav from '@/app/components/layout/TopNav'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import OverviewPerformanceCard, { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
const AdvancedMetricsCard = dynamic(() => import('@/app/components/trader/AdvancedMetricsCard'), { ssr: false })
// MarketCorrelationCard removed -- beta_btc/beta_eth/alpha never computed by pipeline (P0-5)
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { formatDisplayName, formatROI } from '@/app/components/ranking/utils'
import { getAvatarGradient } from '@/lib/utils/avatar'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { usePeriodStore } from '@/lib/stores/periodStore'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'
import { BASE_URL } from '@/lib/constants/urls'
import { features } from '@/lib/features'

const DailyReturnsChart = dynamic(() => import('@/app/components/trader/charts/DailyReturnsChart').then(m => ({ default: m.DailyReturnsChart })), { ssr: false })
const DrawdownChart = dynamic(() => import('@/app/components/trader/charts/DrawdownChart').then(m => ({ default: m.DrawdownChart })), { ssr: false })
const EquityCurveSection = dynamic(() => import('@/app/components/trader/stats/components/EquityCurveSection').then(m => ({ default: m.EquityCurveSection })), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: 200, borderRadius: 16, background: 'var(--color-bg-secondary, #1a1a2e)', border: '1px solid var(--color-border-primary, #2a2a3e)', overflow: 'hidden' }}>
      <div style={{ padding: '16px 20px' }}>
        <div style={{ width: 120, height: 14, borderRadius: 4, background: 'var(--color-bg-tertiary, #252540)', animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
      <div style={{ height: 160, margin: '0 20px 16px', borderRadius: 8, background: 'var(--color-bg-tertiary, #252540)', animation: 'pulse 1.5s ease-in-out infinite', animationDelay: '0.2s' }} />
    </div>
  ),
})
const TradingStyleRadar = dynamic(() => import('@/app/components/trader/TradingStyleRadar'), { ssr: false })
const SimilarTraders = dynamic(() => import('@/app/components/trader/SimilarTraders'), { ssr: false })
import { RankSparkline } from '@/app/components/ranking/RankSparkline'
const CopyTradeSimulator = dynamic(() => import('@/app/components/trader/CopyTradeSimulator'), { ssr: false })
const ClaimTraderButton = dynamic(() => import('@/app/components/trader/ClaimTraderButton'), { ssr: false })
const VerifiedTraderEditor = dynamic(() => import('@/app/components/trader/VerifiedTraderEditor'), { ssr: false })
const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})
const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})
const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})

const SwipeableView = dynamic(() => import('@/app/components/ui/SwipeableView'), { ssr: false })
const LinkedAccountTabs = dynamic(() => import('@/app/components/trader/LinkedAccountTabs'), { ssr: false })
const AggregatedStats = dynamic(() => import('@/app/components/trader/AggregatedStats'), { ssr: false })
const ExchangeLinksBar = dynamic(() => import('@/app/components/trader/ExchangeLinksBar'), { ssr: false })

/** @deprecated UI-specific. Will be replaced by UnifiedTrader adapter. */
export interface UnregisteredTraderData {
  handle: string
  avatar_url?: string | null
  profile_url?: string | null
  source: string
  source_trader_id: string
  rank?: number | null
  arena_score?: number | null
  roi?: number | null
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  sharpe_ratio?: number | null
  sortino_ratio?: number | null
  profit_factor?: number | null
  calmar_ratio?: number | null
  trading_style?: string | null
  avg_holding_hours?: number | null
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  is_platform_dead?: boolean
}

type TraderTabKey = 'overview' | 'stats' | 'portfolio' | 'posts'

// NO_PORTFOLIO_PLATFORMS removed — Portfolio tab shown for ALL platforms
// When no position data exists, the Portfolio component shows an empty state
type TraderPageData = import('@/app/u/[handle]/components/types').TraderPageData

// #31: traderFetcher extracted to lib/hooks/traderFetcher.ts (shared with useUserProfile)

interface ClaimedUserProfile {
  id: string
  handle: string
  bio?: string | null
  avatar_url?: string | null
  cover_url?: string | null
}

interface TraderProfileClientProps {
  data: UnregisteredTraderData
  serverTraderData?: TraderPageData | null
  claimedUser?: ClaimedUserProfile | null
}

export default function TraderProfileClient({ data, serverTraderData, claimedUser }: TraderProfileClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const { t, language: _language } = useLanguage()
  const { isPro } = useSubscription()
  const { userId: currentUserId } = useAuthSession()
  const selectedPeriod = usePeriodStore(s => s.period)

  // P1-7: Read initial period from URL param and sync store on mount
  const urlPeriod = searchParams.get('period')
  const setPeriod = usePeriodStore(s => s.setPeriod)
  useEffect(() => {
    if (urlPeriod && ['7D', '30D', '90D'].includes(urlPeriod)) {
      setPeriod(urlPeriod as '7D' | '30D' | '90D')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

  // P1-7: Sync period changes to URL
  // Skip the very first invocation (mount) — the store default may differ from URL param,
  // and the init effect above hasn't propagated the URL value into the store yet.
  // On mount, both effects fire in order but setPeriod won't update selectedPeriod until
  // the next render, so the sync effect would incorrectly strip the period param from URL.
  const periodSyncCountRef = useRef(0)
  useEffect(() => {
    // Skip the first fire (mount) — let the init effect take over first
    if (periodSyncCountRef.current === 0) {
      periodSyncCountRef.current = 1
      return
    }
    const params = new URLSearchParams(searchParams.toString())
    if (selectedPeriod === '90D') {
      params.delete('period')
    } else {
      params.set('period', selectedPeriod)
    }
    const qs = params.toString()
    const newPath = `${pathname}${qs ? `?${qs}` : ''}`
    const currentPath = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
    if (newPath !== currentPath) {
      router.replace(newPath, { scroll: false })
    }
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps -- only sync when period changes

  const [isVerifiedTrader, setIsVerifiedTrader] = useState(false)
  const [isOwner, setIsOwner] = useState(false)

  // Multi-account linked traders (SWR-based)
  // P7: bundled aggregate data will be passed once traderData loads (see below)
  const [activeAccount, setActiveAccount] = useState<string>('all')

  const displayName = formatDisplayName(data.handle, data.source)
  const _exchangeName = EXCHANGE_NAMES[data.source] || data.source

  // Sticky mini header on mobile — appears when scrolled past main header
  const headerRef = useRef<HTMLDivElement>(null)
  const [showMiniHeader, setShowMiniHeader] = useState(false)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setShowMiniHeader(!entry.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Tabs — always show overview + stats + portfolio; conditionally include 'posts' for claimed traders
  const tabKeys: TraderTabKey[] = useMemo(() => {
    const keys: TraderTabKey[] = ['overview', 'stats', 'portfolio']
    if (claimedUser) keys.push('posts')
    return keys
  }, [claimedUser])
  const urlTab = searchParams.get('tab')
  const initialTab = urlTab && tabKeys.includes(urlTab as TraderTabKey) ? urlTab as TraderTabKey : 'overview'
  const [activeTab, setActiveTab] = useState<TraderTabKey>(initialTab)

  // Track which tabs have been visited — only render tab content after first visit.
  // This avoids mounting heavy components (StatsPage, PortfolioTable, charts) for
  // tabs the user hasn't viewed yet, while SwipeableView still lays out placeholders.
  const [visitedTabs, setVisitedTabs] = useState<Set<TraderTabKey>>(() => new Set([initialTab]))

  const handleAccountChange = useCallback((account: string) => {
    setActiveAccount(account)
    const params = new URLSearchParams(searchParams.toString())
    if (account === 'all') {
      params.delete('account')
    } else {
      params.set('account', account)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  const handleTabChange = useCallback((tab: TraderTabKey) => {
    setActiveTab(tab)
    setVisitedTabs(prev => {
      if (prev.has(tab)) return prev
      const next = new Set(prev)
      next.add(tab)
      return next
    })
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'overview') {
      params.delete('tab')
    } else {
      params.set('tab', tab)
    }
    const qs = params.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [searchParams, pathname, router])

  // ── P7: Merged trader detail fetch (bundles claim + aggregate + rank_history) ──
  // We need linked accounts for activeAccountParsed, but linked accounts also depend
  // on traderData for bundled aggregate. Break the cycle: useLinkedAccounts fires its
  // own SWR on the first render; once traderData arrives with bundled aggregate, the
  // hook suppresses the duplicate fetch on subsequent renders.

  // Step 1: First pass of useLinkedAccounts (may fire its own fetch before bundled data is ready)
  // The bundled aggregate from traderData is passed as third arg — undefined on first render,
  // then populated once traderData loads, which suppresses the separate /api/traders/aggregate call.
  // We forward-declare a ref to hold the bundled aggregate and update it after SWR resolves.
  const bundledAggregateRef = useRef<{ aggregated: unknown; accounts: unknown[]; totalAccounts: number } | null | undefined>(undefined)
  const { linkedAccounts, aggregatedData, hasMultipleAccounts } = useLinkedAccounts(
    data.source,
    data.source_trader_id,
    bundledAggregateRef.current,
  )

  // Parse active account into platform + traderKey for per-account data fetching
  const activeAccountParsed = useMemo(() => {
    if (activeAccount === 'all' || !activeAccount.includes(':')) return null
    const [platform, ...rest] = activeAccount.split(':')
    const traderKey = rest.join(':')
    const account = linkedAccounts.find(a => a.platform === platform && a.traderKey === traderKey)
    return account ? { platform, traderKey, handle: account.handle } : null
  }, [activeAccount, linkedAccounts])

  // SWR for full trader data — switches URL when account tab changes
  // P7: When fetching primary account, bundle claim/aggregate/rank_history via include param (4→1 API call)
  const effectivePlatform = activeAccountParsed?.platform || searchParams?.get('platform') || data.source || ''
  const effectiveHandle = activeAccountParsed?.handle || activeAccountParsed?.traderKey || data.handle || data.source_trader_id
  const isPrimaryAccount = !activeAccountParsed
  const traderApiUrl = useMemo(() => {
    const base = effectivePlatform
      ? `/api/traders/${encodeURIComponent(effectiveHandle)}?source=${encodeURIComponent(effectivePlatform)}`
      : `/api/traders/${encodeURIComponent(effectiveHandle)}`
    // Only bundle extras for the primary account (not when switching linked accounts)
    if (isPrimaryAccount) {
      const separator = base.includes('?') ? '&' : '?'
      return `${base}${separator}include=claim,aggregate,rank_history`
    }
    return base
  }, [effectivePlatform, effectiveHandle, isPrimaryAccount])
  const { data: traderData, error: traderError, isLoading: traderLoading } = useSWR<TraderPageData & {
    claim_status?: { is_verified: boolean; owner_id?: string | null; profile?: Record<string, unknown> }
    aggregate?: { aggregated: unknown; accounts: unknown[]; totalAccounts: number }
    rank_history?: { history: { date: string; rank: number; arena_score: number }[] }
  }>(
    traderApiUrl,
    traderFetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: 5 * 60 * 1000, // 5 min auto-refresh
      dedupingInterval: 5000,
      errorRetryCount: 2,
      fallbackData: isPrimaryAccount ? (serverTraderData ?? undefined) : undefined,
      keepPreviousData: true,
      // #30: Skip revalidation on mount when serverTraderData is provided (ISR freshness)
      revalidateOnMount: isPrimaryAccount && serverTraderData ? false : undefined,
    }
  )

  // P7: Extract bundled data from merged response
  const bundledClaimData = traderData?.claim_status
  const bundledRankHistory = traderData?.rank_history

  // P7: Update bundled aggregate ref so useLinkedAccounts can use it on next render
  if (traderData?.aggregate) {
    bundledAggregateRef.current = traderData.aggregate
  }

  // Check if this trader is verified (claimed) and if current user is the owner.
  // P7: Skip separate fetch when bundled claim data is available from merged endpoint
  const claimUrl = (!bundledClaimData && data.source_trader_id && data.source)
    ? `/api/traders/claim/status?trader_id=${encodeURIComponent(data.source_trader_id)}&source=${encodeURIComponent(data.source)}`
    : null
  const { data: claimData } = useSWR<{ success: boolean; data: { is_verified: boolean; owner_id: string | null } }>(
    claimUrl,
    fetcher,
    { revalidateOnFocus: true, dedupingInterval: 30_000 }
  )

  // Derive verified/owner state from SWR claim data or bundled claim data
  useEffect(() => {
    // Prefer bundled claim data from merged endpoint
    const claimSource = bundledClaimData ?? claimData?.data
    const isVerified = !!claimSource?.is_verified
    setIsVerifiedTrader(isVerified)
    setIsOwner(isVerified && !!currentUserId && claimSource?.owner_id === currentUserId)
  }, [bundledClaimData, claimData, currentUserId])

  // Rank history for sparkline (7-day trajectory)
  // P7: Skip separate fetch when bundled data is available from the merged endpoint
  const rankHistoryUrl = (!bundledRankHistory && effectivePlatform && effectiveHandle)
    ? `/api/trader/rank-history?platform=${encodeURIComponent(effectivePlatform)}&trader_key=${encodeURIComponent(data.source_trader_id)}&period=90D&days=7`
    : null
  const { data: rankHistoryData } = useSWR<{ history: { date: string; rank: number; arena_score: number }[] }>(
    rankHistoryUrl,
    traderFetcher,
    { revalidateOnFocus: false, dedupingInterval: 60000, errorRetryCount: 1 }
  )
  const rankSparklineData = (bundledRankHistory?.history ?? rankHistoryData?.history)?.map(h => ({ rank: h.rank })) ?? []

  const traderProfile = traderData?.profile ?? null
  const traderPerformance = traderData?.performance ?? null
  const traderStats = traderData?.stats ?? null
  const traderPortfolio = traderData?.portfolio ?? []
  const traderPositionHistory = traderData?.positionHistory ?? []
  const traderEquityCurve = traderData?.equityCurve
  const traderAssetBreakdown = traderData?.assetBreakdown
  const traderSimilar = traderData?.similarTraders ?? []

  // Loading state: only when SWR is loading AND no server fallback
  const isInitialLoading = traderLoading && !serverTraderData
  if (isInitialLoading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  // Error state: only when SWR errored AND no cached data available
  if (traderError && !traderData) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center', paddingTop: tokens.spacing[8] }}>
          <div style={{ fontSize: 48, marginBottom: tokens.spacing[4] }}>⚠️</div>
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('loadFailedRetryMsg')}
          </Text>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[5] }}>
            {traderError?.message || t('networkError')}
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: tokens.colors.accent.brand,
                color: tokens.colors.white,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t('retry')}
            </button>
            <Link href="/rankings" style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              fontWeight: 600,
            }}>
              {t('leaderboardBreadcrumb')}
            </Link>
          </Box>
        </Box>
      </Box>
    )
  }

  // #24: Stale data banner — show when SWR errored but cached/stale data is still available
  const showStaleBanner = !!traderError && !!traderData

  // Structured data for SEO
  const structuredData = combineSchemas(
    generateTraderProfilePageSchema({
      handle: data.handle,
      id: data.source_trader_id,
      source: data.source,
      roi90d: data.roi ?? undefined,
      winRate: data.win_rate ?? undefined,
      maxDrawdown: data.max_drawdown ?? undefined,
      arenaScore: data.arena_score ?? undefined,
      avatarUrl: data.avatar_url ?? undefined,
    }),
    generateBreadcrumbSchema([
      { name: 'Home', url: BASE_URL },
      { name: 'Ranking', url: `${BASE_URL}/rankings` },
      { name: data.handle },
    ])
  )

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        color: tokens.colors.text.primary,
      }}
    >
      <JsonLd data={structuredData} />
      <TopNav />

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[
          { label: t('leaderboardBreadcrumb'), href: '/rankings' },
          { label: displayName },
        ]} />

        {/* #24: Stale data banner */}
        {showStaleBanner && (
          <Box style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            marginBottom: tokens.spacing[3],
            background: `${tokens.colors.accent.warning}12`,
            border: `1px solid ${tokens.colors.accent.warning}30`,
            borderRadius: tokens.radius.md,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}>
            <Text size="xs" style={{ color: tokens.colors.accent.warning }}>
              {t('dataOutdatedBanner') || 'Data may be outdated. Refresh to get the latest.'}
            </Text>
          </Box>
        )}

        {data.is_platform_dead && (
          <Box style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            marginBottom: tokens.spacing[3],
            background: `${tokens.colors.accent.error}10`,
            border: `1px solid ${tokens.colors.accent.error}25`,
            borderRadius: tokens.radius.md,
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
          }}>
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>
              {t('platformDataUnavailable') || `Data for ${EXCHANGE_NAMES[data.source] || data.source} is temporarily unavailable. Historical data shown below may be outdated.`}
            </Text>
          </Box>
        )}

        {/* Sticky mini header for mobile */}
        <div className={`trader-sticky-mini-header${showMiniHeader ? ' visible' : ''}`}>
          <div className="mini-avatar" style={{ background: data.avatar_url ? 'var(--color-bg-tertiary)' : getAvatarGradient(data.source_trader_id), display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, color: '#fff' }}>
            {data.avatar_url ? (
              <Image src={`/api/avatar?url=${encodeURIComponent(data.avatar_url)}`} alt={displayName} width={28} height={28} style={{ width: '100%', height: '100%', objectFit: 'cover' }} unoptimized />
            ) : (
              displayName.charAt(0).toUpperCase()
            )}
          </div>
          <span className="mini-name">{displayName}</span>
          {data.roi != null && (
            <span className="mini-roi" style={{ color: data.roi >= 0 ? 'var(--color-success)' : 'var(--color-error)' }}>
              {formatROI(data.roi)}
            </span>
          )}
        </div>

        {/* Trader Header */}
        <div ref={headerRef}>
        <TraderHeader
          handle={traderProfile?.handle || data.handle}
          displayName={displayName}
          traderId={traderProfile?.id || data.source_trader_id}
          avatarUrl={traderProfile?.avatar_url || data.avatar_url || undefined}
          isRegistered={!!claimedUser}
          isOwnProfile={isOwner}
          followers={traderProfile?.followers ?? undefined}
          profileUrl={traderProfile?.profile_url || data.profile_url || undefined}
          source={traderProfile?.source || data.source}
          isPro={isPro}
          roi90d={traderPerformance?.roi_90d ?? (data.roi != null ? data.roi : undefined)}
          maxDrawdown={traderPerformance?.max_drawdown ?? data.max_drawdown ?? undefined}
          winRate={traderPerformance?.win_rate ?? data.win_rate ?? undefined}
          arenaScore={hasMultipleAccounts && activeAccount === 'all' && aggregatedData
            ? aggregatedData.weightedScore
            : (traderPerformance as ExtendedPerformance | null)?.arena_score_90d ?? data.arena_score ?? null}
          rank={data.rank ?? null}
          currentUserId={currentUserId}
          isVerifiedTrader={isVerifiedTrader}
          isBot={data.source === 'web3_bot'}
          lastUpdated={traderData?.trackedSince}
          claimedBio={claimedUser?.bio || (traderProfile as Record<string, unknown> | null)?.bio as string | undefined}
          claimedAvatarUrl={claimedUser?.avatar_url}
          linkedAccountCount={hasMultipleAccounts ? linkedAccounts.length : undefined}
          linkedPlatforms={hasMultipleAccounts ? linkedAccounts.map(a => a.platform) : undefined}
          platform={effectivePlatform}
          traderKey={data.source_trader_id}
        />
        </div>

        {/* Rank sparkline — 7-day rank trajectory */}
        {rankSparklineData.length >= 2 && (
          <Box style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            marginTop: tokens.spacing[2],
            marginBottom: tokens.spacing[1],
          }}>
            <Text size="xs" color="tertiary">
              {t('rankTrend') || 'Rank trend (7d)'}
            </Text>
            <RankSparkline data={rankSparklineData} width={80} height={24} />
          </Box>
        )}

        {/* Multi-account tabs (only shown when user has 2+ linked accounts) */}
        {hasMultipleAccounts && (
          <LinkedAccountTabs
            accounts={linkedAccounts}
            activeAccount={activeAccount}
            onAccountChange={handleAccountChange}
          />
        )}

        {/* Exchange links — copy-trade / DEX view per exchange, below header */}
        <ExchangeLinksBar
          primary={{ platform: data.source, traderKey: data.source_trader_id, handle: data.handle }}
          linkedAccounts={hasMultipleAccounts
            ? linkedAccounts.map(a => ({ platform: a.platform, traderKey: a.traderKey, handle: a.handle }))
            : undefined
          }
          activeAccount={activeAccount}
          isOwnProfile={isOwner}
        />

        {/* Tabs */}
        <TraderTabs
          activeTab={activeTab}
          onTabChange={handleTabChange}
          isPro={isPro}
          onProRequired={() => router.push('/pricing')}
          extraTabs={claimedUser ? ['posts'] : undefined}
          hideTabs={undefined}
        />

        {/* Tab Content — dims while loading account switch */}
        <div style={{
          opacity: (traderLoading && !isPrimaryAccount) ? 0.5 : 1,
          transition: 'opacity 0.2s ease',
          pointerEvents: (traderLoading && !isPrimaryAccount) ? 'none' : 'auto',
        }}>
        <SwipeableView
          activeIndex={tabKeys.indexOf(activeTab)}
          onIndexChange={(i) => handleTabChange(tabKeys[i])}
        >
          {/* Overview Tab */}
          <Box style={{ minHeight: 200 }} key={activeTab} className="tab-pane-enter">
            {(activeTab === 'overview') && (
            <Box
              className="profile-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: traderSimilar.length > 0 ? '1fr 300px' : '1fr',
                gap: tokens.spacing[6],
              }}
            >
              <Box className="stagger-enter" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                {/* Aggregated stats card (only when "All" tab is active and user has 2+ accounts) */}
                {hasMultipleAccounts && activeAccount === 'all' && aggregatedData && (
                  <AggregatedStats
                    combinedPnl={aggregatedData.combinedPnl}
                    bestRoi={aggregatedData.bestRoi}
                    weightedScore={aggregatedData.weightedScore}
                    accounts={linkedAccounts.map(a => ({
                      platform: a.platform,
                      traderKey: a.traderKey,
                      handle: a.handle,
                      label: a.label,
                      roi: a.roi,
                      pnl: a.pnl,
                      arenaScore: a.arenaScore,
                      winRate: a.winRate,
                      maxDrawdown: a.maxDrawdown,
                      rank: a.rank,
                      isPrimary: a.isPrimary,
                    }))}
                  />
                )}

                {traderPerformance ? (
                  <OverviewPerformanceCard
                    performance={traderPerformance as ExtendedPerformance}
                    equityCurve={traderEquityCurve?.['90D']}
                    allEquityCurves={traderEquityCurve as Record<string, Array<{ date: string; roi: number; pnl: number }>> | undefined}
                    source={traderProfile?.source || data.source}
                  />
                ) : (
                  <Box style={{
                    padding: `${tokens.spacing[6]} ${tokens.spacing[5]}`,
                    background: tokens.colors.bg.secondary,
                    borderRadius: tokens.radius.xl,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                  }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: 'var(--color-text-tertiary)', opacity: 0.3 }}>
                      <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M7 16l4-8 4 4 4-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <Text size="sm" color="tertiary">
                      {t('traderPerformanceUnavailable')}
                    </Text>
                  </Box>
                )}

                {/* Equity Curve Chart */}
                {traderEquityCurve && (
                  <SectionErrorBoundary>
                    <EquityCurveSection
                      equityCurve={traderEquityCurve}
                      traderHandle={traderProfile?.handle || data.handle}
                      delay={0}
                    />
                  </SectionErrorBoundary>
                )}

                {/* Drawdown Chart — P1-6: follows selected period */}
                {(() => {
                  const curve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
                  if (!curve || curve.length <= 2) return null
                  return (
                    <Box
                      className="glass-card"
                      style={{
                        padding: tokens.spacing[5],
                        background: tokens.colors.bg.secondary,
                        borderRadius: tokens.radius.xl,
                        border: `1px solid ${tokens.colors.border.primary}60`,
                      }}
                    >
                      <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3] }}>
                        {t('drawdownChart') || 'Drawdown'} ({selectedPeriod})
                      </Text>
                      <SectionErrorBoundary><DrawdownChart equityCurve={curve} /></SectionErrorBoundary>
                    </Box>
                  )
                })()}

                {/* Copy-Trade Simulator — follows selected period */}
                {(() => {
                  const simCurve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
                  if (!simCurve || simCurve.length <= 2) return null
                  return <SectionErrorBoundary><CopyTradeSimulator equityCurve={simCurve} /></SectionErrorBoundary>
                })()}

                {/* Daily Returns Distribution — P1-6: follows selected period */}
                {(() => {
                  const curve = traderEquityCurve?.[selectedPeriod] ?? traderEquityCurve?.['90D']
                  if (!curve || curve.length <= 5) return null
                  const dailyReturns = curve.slice(1).map((point, i) => ({
                    date: point.date,
                    returnPct: Math.abs(curve[i].roi ?? 0) > 0.001
                      ? ((point.roi - curve[i].roi) / Math.abs(curve[i].roi)) * 100
                      : (point.roi - curve[i].roi),
                  })).filter(d => Number.isFinite(d.returnPct))
                  if (dailyReturns.length <= 5) return null
                  return (
                    <Box
                      className="glass-card"
                      style={{
                        padding: tokens.spacing[5],
                        background: tokens.colors.bg.secondary,
                        borderRadius: tokens.radius.xl,
                        border: `1px solid ${tokens.colors.border.primary}60`,
                      }}
                    >
                      <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3] }}>
                        {t('dailyReturnsDistribution') || 'Daily Returns Distribution'} ({selectedPeriod})
                      </Text>
                      <SectionErrorBoundary><DailyReturnsChart data={dailyReturns} /></SectionErrorBoundary>
                    </Box>
                  )
                })()}

                {/* P0-6: Advanced Metrics — prefer SWR data, fallback to server data */}
                {(() => {
                  const perf = traderPerformance as Record<string, unknown> | null
                  const sortino = (perf?.sortino_ratio as number | null) ?? data.sortino_ratio ?? null
                  const calmar = (perf?.calmar_ratio as number | null) ?? data.calmar_ratio ?? null
                  const profitFactor = (perf?.profit_factor as number | null) ?? data.profit_factor ?? null
                  const avgHolding = (perf?.avg_holding_time_hours as number | null) ?? data.avg_holding_hours ?? null
                  const avgProfitVal = (perf?.avg_profit as number | null) ?? null
                  const avgLossVal = (perf?.avg_loss as number | null) ?? null
                  const lWin = (perf?.largest_win as number | null) ?? null
                  const lLoss = (perf?.largest_loss as number | null) ?? null
                  if (sortino == null && calmar == null && profitFactor == null && avgProfitVal == null && lWin == null) return null
                  return (
                    <AdvancedMetricsCard
                      metrics={{
                        sortino_ratio: sortino,
                        calmar_ratio: calmar,
                        profit_factor: profitFactor,
                        recovery_factor: null,
                        max_consecutive_wins: null,
                        max_consecutive_losses: null,
                        avg_holding_hours: avgHolding,
                        volatility_pct: null,
                        downside_volatility_pct: null,
                      }}
                      avgProfit={avgProfitVal}
                      avgLoss={avgLossVal}
                      largestWin={lWin}
                      largestLoss={lLoss}
                    />
                  )
                })()}



                {/* Trading Style Radar */}
                {(data.profitability_score != null || data.risk_control_score != null || data.execution_score != null) && (
                  <Box
                    className="glass-card"
                    style={{
                      padding: tokens.spacing[5],
                      background: tokens.colors.bg.secondary,
                      borderRadius: tokens.radius.xl,
                      border: `1px solid ${tokens.colors.border.primary}60`,
                    }}
                  >
                    <Text size="sm" weight="bold" style={{ color: 'var(--color-text-secondary)', marginBottom: tokens.spacing[3], textAlign: 'center' }}>
                      {t('traderTradingStyleLabel')}
                    </Text>
                    <SectionErrorBoundary>
                      <TradingStyleRadar
                        profitability={data.profitability_score}
                        riskControl={data.risk_control_score}
                        execution={data.execution_score}
                        winRate={data.win_rate}
                        maxDrawdown={data.max_drawdown}
                      />
                    </SectionErrorBoundary>
                  </Box>
                )}

                {/* Verified trader edit OR Claim CTA */}
                {isOwner ? (
                  <VerifiedTraderEditor
                    traderId={data.source_trader_id}
                    source={data.source}
                    currentData={{}}
                    onSaved={() => window.location.reload()}
                  />
                ) : !isVerifiedTrader && !claimedUser && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 16px',
                    background: 'var(--color-bg-secondary)',
                    borderRadius: 8,
                    border: '1px solid var(--color-border-primary)',
                    fontSize: 13,
                  }}>
                    <span style={{ color: 'var(--color-text-secondary)', flex: 1 }}>
                      {t('claimYourProfileShort')}
                    </span>
                    {currentUserId ? (
                      <ClaimTraderButton
                        traderId={traderProfile?.id || data.source_trader_id}
                        handle={traderProfile?.handle || data.handle}
                        userId={currentUserId}
                        source={traderProfile?.source || data.source}
                      />
                    ) : (
                      <a
                        href={`/login?returnUrl=${encodeURIComponent(`/trader/${encodeURIComponent(data.handle)}`)}`}
                        style={{
                          padding: '6px 16px',
                          borderRadius: 6,
                          background: 'var(--color-brand)',
                          color: 'white',
                          fontWeight: 600,
                          fontSize: 12,
                          textDecoration: 'none',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t('loginToClaim')}
                      </a>
                    )}
                  </div>
                )}
              </Box>

              {(traderSimilar.length > 0 || features.social) && (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
                  {traderSimilar.length > 0 && <SectionErrorBoundary><SimilarTraders traders={traderSimilar} /></SectionErrorBoundary>}
                  {features.social && (
                    <Link href="/groups" prefetch={false} style={{ textDecoration: 'none' }}>
                      <Box
                        className="glass-card"
                        style={{
                          padding: tokens.spacing[5],
                          background: tokens.colors.bg.secondary,
                          borderRadius: tokens.radius.xl,
                          border: `1px solid ${tokens.colors.border.primary}60`,
                          transition: 'all 0.2s',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => {
                          e.currentTarget.style.borderColor = tokens.colors.accent.primary + '60'
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => {
                          e.currentTarget.style.borderColor = tokens.colors.border.primary + '60'
                        }}
                      >
                        <Box style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: tokens.spacing[2] }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" />
                          </svg>
                          <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                            {t('communityDiscoverTitle')}
                          </Text>
                        </Box>
                        <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
                          {t('communityDiscoverDesc')}
                        </Text>
                      </Box>
                    </Link>
                  )}
                </Box>
              )}
            </Box>
          )}
          </Box>

          {/* Stats Tab — lazy: only mount after first visit */}
          <Box style={{ minHeight: 200 }}>
            {visitedTabs.has('stats') && traderStats ? (
              <StatsPage
                stats={traderStats}
                traderHandle={traderProfile?.handle || data.handle}
                assetBreakdown={traderAssetBreakdown}
                equityCurve={traderEquityCurve as { '90D': Array<{ date: string; roi: number; pnl: number }>; '30D': Array<{ date: string; roi: number; pnl: number }>; '7D': Array<{ date: string; roi: number; pnl: number }> } | undefined}
                positionHistory={traderPositionHistory}
                isPro={isPro}
                onUnlock={() => router.push('/pricing')}
              />
            ) : visitedTabs.has('stats') ? (
              <Box style={{
                padding: tokens.spacing[6],
                background: tokens.colors.bg.secondary,
                borderRadius: tokens.radius.xl,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
              }}>
                <Text size="sm" color="tertiary">
                  {t('noStatsData')}
                </Text>
              </Box>
            ) : (
              <RankingSkeleton />
            )}
          </Box>

          {/* Portfolio Tab — lazy: only mount after first visit */}
          <Box style={{ minHeight: 200 }}>
            {!visitedTabs.has('portfolio') ? (
              <RankingSkeleton />
            ) : traderPortfolio.length === 0 && traderPositionHistory.length === 0 ? (
              <Box style={{
                padding: tokens.spacing[10],
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[3],
              }}>
                <Box style={{
                  width: 48, height: 48,
                  borderRadius: tokens.radius.full,
                  background: `${tokens.colors.text.tertiary}10`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <polyline points="13 2 13 9 20 9" />
                  </svg>
                </Box>
                <Text size="base" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
                  {t('noPortfolioData')}
                </Text>
                {data.source && EXCHANGE_NAMES[data.source.toLowerCase()] && (
                  <Text size="sm" color="tertiary">
                    {t('viewOnExchange').replace('{exchange}', EXCHANGE_NAMES[data.source.toLowerCase()])}
                  </Text>
                )}
              </Box>
            ) : (
              <PortfolioTable
                items={traderPortfolio}
                history={traderPositionHistory}
                isPro={isPro}
                onUnlock={() => router.push('/pricing')}
              />
            )}
          </Box>

          {/* Posts Tab (only for claimed traders) */}
          {claimedUser && (
            <Box style={{ minHeight: 200 }}>
              {activeTab === 'posts' && (
                <Box bg="secondary" p={4} radius="lg" border="primary" style={{ maxWidth: 900 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
                    <Text size="lg" weight="black">{t('posts')}</Text>
                  </Box>
                  <PostFeed
                    authorHandle={claimedUser.handle}
                    variant="compact"
                    showSortButtons
                  />
                </Box>
              )}
            </Box>
          )}
        </SwipeableView>
        </div>

        <style>{`
          .profile-tabs::-webkit-scrollbar { display: none; }
          @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @media (max-width: 1024px) {
            .profile-grid {
              grid-template-columns: 1fr !important;
            }
          }
          @media (max-width: 768px) {
            .page-container {
              padding: ${tokens.spacing[3]} !important;
              padding-bottom: 100px !important;
            }
          }
        `}</style>

        {/* Data disclaimer */}
        <Text
          size="xs"
          color="tertiary"
          style={{ textAlign: 'center', marginTop: tokens.spacing[6], opacity: 0.7 }}
        >
          {t('dataDisclaimer')}
        </Text>
      </Box>
    </Box>
  )
}
