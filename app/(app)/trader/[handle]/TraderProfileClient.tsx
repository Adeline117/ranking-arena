'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { useQuery } from '@tanstack/react-query'
import { STALE_STANDARD, STALE_RELAXED } from '@/lib/hooks/cache-presets'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { fetcher } from '@/lib/hooks/fetchers'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLinkedAccounts } from '@/lib/hooks/useLinkedAccounts'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { trackEvent } from '@/lib/analytics/track'
import { Box, Text } from '@/app/components/base'
// TopNav is now rendered by app/(app)/trader/[handle]/layout.tsx
// (was pulled into this client bundle unnecessarily before).
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
// MarketCorrelationCard removed -- beta_btc/beta_eth/alpha never computed by pipeline (P0-5)
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { formatDisplayName, formatROI } from '@/app/components/ranking/utils'
import { getAvatarGradient } from '@/lib/utils/avatar'
// JSON-LD structured data is emitted by the server component (page.tsx).
// Do NOT emit it here — that causes duplicate ProfilePage + BreadcrumbList.
import { RankSparkline } from '@/app/components/ranking/RankSparkline'

// Memoized tab components — each wraps its own subtree so SWR revalidations
// on one tab don't cause reconciliation of the others.
import OverviewTab from '@/app/components/trader/tabs/OverviewTab'
import StatsTab from '@/app/components/trader/tabs/StatsTab'
import PortfolioTab from '@/app/components/trader/tabs/PortfolioTab'

const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})

const SwipeableView = dynamic(() => import('@/app/components/ui/SwipeableView'), { ssr: false })
const LinkedAccountTabs = dynamic(() => import('@/app/components/trader/LinkedAccountTabs'), {
  ssr: false,
  loading: () => <div style={{ minHeight: 48 }} />,
})
// ExchangeLinksBar — static import (no client-only deps). Previously dynamic
// with ssr:false, which caused a 30-80px CLS pop-in above the fold on every
// trader page load. Static import eliminates the flash + reduces chunk count.
import ExchangeLinksBar from '@/app/components/trader/ExchangeLinksBar'

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

// TraderTabKey moved to ./hooks/useTraderTabs
import { useTraderPeriodSync } from './hooks/useTraderPeriodSync'
import { useTraderActiveAccount } from './hooks/useTraderActiveAccount'
import { useTraderTabs } from './hooks/useTraderTabs'
import { TraderProfileError } from './components/TraderProfileError'
import { TraderStaleBanner, TraderPlatformDeadBanner } from './components/TraderStatusBanners'

// NO_PORTFOLIO_PLATFORMS removed — Portfolio tab shown for ALL platforms
// When no position data exists, the Portfolio component shows an empty state
type TraderPageData = import('@/app/(app)/u/[handle]/components/types').TraderPageData

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

export default function TraderProfileClient({
  data,
  serverTraderData,
  claimedUser,
}: TraderProfileClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t, language: _language } = useLanguage()
  const { isPro } = useSubscription()
  const { userId: currentUserId } = useAuthSession()

  // Period URL ↔ store sync extracted into hook (see ./hooks/useTraderPeriodSync)
  const selectedPeriod = useTraderPeriodSync()

  // Track trader profile page view (funnel: browse → trader detail)
  useEffect(() => {
    trackEvent('view_trader', {
      platform: data.source,
      handle: data.handle || data.source_trader_id,
    })
  }, [data.source, data.handle, data.source_trader_id])

  const [isVerifiedTrader, setIsVerifiedTrader] = useState(false)
  const [isOwner, setIsOwner] = useState(false)

  // Active account state machine extracted into hook (./hooks/useTraderActiveAccount).
  // Owns: activeAccount string, parsed activeAccountRaw, change handler. Critical
  // invariant: parses platform:traderKey inline without needing linkedAccounts.
  const { activeAccount, activeAccountRaw, handleAccountChange } = useTraderActiveAccount()

  const displayName = formatDisplayName(data.handle, data.source)
  const _exchangeName = EXCHANGE_NAMES[data.source] || data.source

  // Sticky mini header on mobile — appears when scrolled past main header
  const headerRef = useRef<HTMLDivElement>(null)
  const [showMiniHeader, setShowMiniHeader] = useState(false)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => setShowMiniHeader(!entry.isIntersecting), {
      threshold: 0,
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Tabs state extracted into hook (./hooks/useTraderTabs). Owns tabKeys list,
  // active tab, visited-tab tracking (for lazy mount), and URL change handler.
  const { tabKeys, activeTab, visitedTabs, handleTabChange } = useTraderTabs(claimedUser)

  // Stable callback for pricing redirect — avoids creating new closure on every render
  // which would defeat React.memo in StatsTab / PortfolioTab.
  const handlePricingRedirect = useCallback(() => router.push('/pricing'), [router])

  // ── P7: Merged trader detail fetch (bundles claim + aggregate + rank_history) ──
  // Fetch order: primary trader detail → then linked accounts (with bundled aggregate).
  // This breaks the prior waterfall: the old code read a ref that wasn't populated
  // until after useLinkedAccounts had already fired its own duplicate fetch.
  //
  // The URL only depends on `data` + `activeAccount` (parsed inline, no lookup),
  // so it doesn't need linkedAccounts. handle-vs-traderKey is resolved separately
  // below for display purposes.

  // SWR for full trader data — switches URL when account tab changes
  // P7: When fetching primary account, bundle claim/aggregate/rank_history via include param (4→1 API call)
  const effectivePlatform =
    activeAccountRaw?.platform || searchParams?.get('platform') || data.source || ''
  const effectiveHandle = activeAccountRaw?.traderKey || data.handle || data.source_trader_id
  const isPrimaryAccount = !activeAccountRaw
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
  type TraderDataWithExtras = TraderPageData & {
    claim_status?: {
      is_verified: boolean
      owner_id?: string | null
      profile?: Record<string, unknown>
    }
    aggregate?: { aggregated: unknown; accounts: unknown[]; totalAccounts: number }
    rank_history?: { history: { date: string; rank: number; arena_score: number }[] }
  }
  const {
    data: traderData,
    error: traderError,
    isLoading: traderLoading,
  } = useQuery<TraderDataWithExtras>({
    queryKey: ['trader-profile', traderApiUrl],
    queryFn: () => traderFetcher<TraderDataWithExtras>(traderApiUrl),
    refetchOnWindowFocus: false,
    // Pause auto-refresh when the tab is hidden to save bandwidth/CPU/battery
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? false
        : 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    staleTime: STALE_STANDARD,
    // Don't retry 404s — trader definitively doesn't exist. Retry transient errors.
    retry: (failureCount, error) => {
      if ((error as Error & { status?: number }).status === 404) return false
      return failureCount < 2
    },
    initialData: isPrimaryAccount
      ? ((serverTraderData as TraderDataWithExtras) ?? undefined)
      : undefined,
    placeholderData: (prev) => prev,
    // #30: Skip refetch on mount when serverTraderData is provided (ISR freshness)
    refetchOnMount: isPrimaryAccount && serverTraderData ? false : true,
  })

  // P7: Extract bundled data from merged response
  const bundledClaimData = traderData?.claim_status
  const bundledRankHistory = traderData?.rank_history

  // Now safe to call useLinkedAccounts — bundled aggregate is passed directly,
  // no ref gymnastics. On first render (before SWR resolves), undefined → hook
  // fires its own fetch. After SWR resolves, bundled data suppresses duplicate fetch.
  // The key improvement vs the old ref-based code: the suppression happens on the
  // first render where bundled data is available (not the render AFTER that).
  const { linkedAccounts, aggregatedData, hasMultipleAccounts } = useLinkedAccounts(
    data.source,
    data.source_trader_id,
    traderData?.aggregate
  )

  // Check if this trader is verified (claimed) and if current user is the owner.
  // P7: Skip separate fetch when bundled claim data is available from merged endpoint
  const claimUrl =
    !bundledClaimData && data.source_trader_id && data.source
      ? `/api/traders/claim/status?trader_id=${encodeURIComponent(data.source_trader_id)}&source=${encodeURIComponent(data.source)}`
      : null
  const { data: claimData } = useQuery<{
    success: boolean
    data: { is_verified: boolean; owner_id: string | null }
  }>({
    queryKey: ['trader-claim-status', data.source_trader_id, data.source],
    queryFn: () => fetcher(claimUrl!),
    enabled: !!claimUrl,
    refetchOnWindowFocus: true,
    staleTime: STALE_STANDARD,
  })

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
  const rankHistoryUrl =
    !bundledRankHistory && effectivePlatform && effectiveHandle
      ? `/api/trader/rank-history?platform=${encodeURIComponent(effectivePlatform)}&trader_key=${encodeURIComponent(data.source_trader_id)}&period=90D&days=7`
      : null
  const { data: rankHistoryData } = useQuery<{
    history: { date: string; rank: number; arena_score: number }[]
  }>({
    queryKey: ['trader-rank-history', effectivePlatform, data.source_trader_id],
    queryFn: () => traderFetcher(rankHistoryUrl!),
    enabled: !!rankHistoryUrl,
    refetchOnWindowFocus: false,
    staleTime: STALE_RELAXED,
    retry: 1,
  })
  const rankSparklineData =
    (bundledRankHistory?.history ?? rankHistoryData?.history)?.map((h) => ({ rank: h.rank })) ?? []

  // Stable references for derived SWR data — memoize so child components
  // wrapped in React.memo can bail out of re-render when traderData
  // identity changes but the underlying field hasn't.
  const traderProfile = useMemo(() => traderData?.profile ?? null, [traderData?.profile])
  const traderPerformance = useMemo(
    () => traderData?.performance ?? null,
    [traderData?.performance]
  )
  const traderStats = useMemo(() => traderData?.stats ?? null, [traderData?.stats])
  const traderPortfolio = useMemo(() => traderData?.portfolio ?? [], [traderData?.portfolio])
  const traderPositionHistory = useMemo(
    () => traderData?.positionHistory ?? [],
    [traderData?.positionHistory]
  )
  const traderEquityCurve = useMemo(() => traderData?.equityCurve, [traderData?.equityCurve])
  const traderAssetBreakdown = useMemo(
    () => traderData?.assetBreakdown,
    [traderData?.assetBreakdown]
  )
  const traderSimilar = useMemo(
    () => traderData?.similarTraders ?? [],
    [traderData?.similarTraders]
  )

  // Loading state: only when SWR is loading AND no server fallback
  const isInitialLoading = traderLoading && !serverTraderData
  if (isInitialLoading) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  // Not found state: API returned 404 (trader definitively does not exist).
  // Distinct from transient errors — only shows when the server confirms the trader is missing.
  const isNotFound =
    traderError && !traderData && (traderError as Error & { status?: number }).status === 404
  if (isNotFound) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          color: tokens.colors.text.primary,
        }}
      >
        <Box
          style={{
            maxWidth: 500,
            margin: '0 auto',
            padding: tokens.spacing[6],
            paddingTop: tokens.spacing[8],
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 900,
              lineHeight: 1.2,
              background: `linear-gradient(135deg, ${tokens.colors.accent.brand} 0%, ${tokens.colors.text.tertiary} 100%)`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              marginBottom: tokens.spacing[4],
            }}
          >
            404
          </div>
          <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('traderNotFoundTitle')}
          </Text>
          <Text
            size="sm"
            color="tertiary"
            style={{ marginBottom: tokens.spacing[6], lineHeight: 1.6 }}
          >
            {t('traderNotFoundDesc')}
          </Text>
          <Box
            style={{
              display: 'flex',
              gap: tokens.spacing[3],
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Link
              href="/rankings"
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: tokens.colors.accent.brand,
                color: tokens.colors.white,
                fontWeight: 700,
                textDecoration: 'none',
                fontSize: 14,
              }}
            >
              {t('leaderboardBreadcrumb')}
            </Link>
            <Link
              href="/search"
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {t('search')}
            </Link>
          </Box>
        </Box>
      </Box>
    )
  }

  // Error state: only when SWR errored AND no cached data available
  if (traderError && !traderData) {
    return <TraderProfileError t={t} errorMessage={traderError?.message} />
  }

  // #24: Stale data banner — show when SWR errored but cached/stale data is still available
  const showStaleBanner = !!traderError && !!traderData

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}30 100%)`,
        color: tokens.colors.text.primary,
        overflowX: 'hidden',
      }}
    >
      {/* TopNav is rendered by the parent layout.tsx (server component) */}

      <Box
        className="page-container"
        style={{
          maxWidth: 1200,
          width: '100%',
          margin: '0 auto',
          padding: tokens.spacing[6],
          paddingBottom: 100,
          overflowX: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <Breadcrumb
          items={[{ label: t('leaderboardBreadcrumb'), href: '/rankings' }, { label: displayName }]}
        />

        <TraderStaleBanner show={showStaleBanner} t={t} />
        <TraderPlatformDeadBanner show={!!data.is_platform_dead} source={data.source} t={t} />

        {/* Sticky mini header for mobile */}
        <div className={`trader-sticky-mini-header${showMiniHeader ? ' visible' : ''}`}>
          <div
            className="mini-avatar"
            style={{
              background: data.avatar_url
                ? 'var(--color-bg-tertiary)'
                : getAvatarGradient(data.source_trader_id),
              display: 'grid',
              placeItems: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            {data.avatar_url ? (
              <Image
                src={
                  data.avatar_url.startsWith('data:')
                    ? data.avatar_url
                    : `/api/avatar?url=${encodeURIComponent(data.avatar_url)}`
                }
                alt={displayName}
                width={28}
                height={28}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                unoptimized
              />
            ) : (
              displayName.charAt(0).toUpperCase()
            )}
          </div>
          <span className="mini-name">{displayName}</span>
          {data.roi != null && (
            <span
              className="mini-roi"
              style={{
                color: data.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}
            >
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
            source={traderProfile?.source || data.source}
            roi90d={traderPerformance?.roi_90d ?? (data.roi != null ? data.roi : undefined)}
            arenaScore={
              hasMultipleAccounts && activeAccount === 'all' && aggregatedData
                ? aggregatedData.weightedScore
                : ((traderPerformance as ExtendedPerformance | null)?.arena_score_90d ??
                  data.arena_score ??
                  null)
            }
            scoreConfidence={
              ((traderPerformance as ExtendedPerformance | null)?.score_confidence as string) ??
              null
            }
            tradesCount={
              ((traderPerformance as ExtendedPerformance | null)?.trades_count as number) ?? null
            }
            rank={data.rank ?? null}
            currentUserId={currentUserId}
            isVerifiedTrader={isVerifiedTrader}
            isBot={data.source === 'web3_bot'}
            lastUpdated={traderData?.lastUpdated ?? traderData?.trackedSince}
            claimedBio={
              claimedUser?.bio ||
              ((traderProfile as Record<string, unknown> | null)?.bio as string | undefined)
            }
            claimedAvatarUrl={claimedUser?.avatar_url}
            linkedAccountCount={hasMultipleAccounts ? linkedAccounts.length : undefined}
            linkedPlatforms={
              hasMultipleAccounts ? linkedAccounts.map((a) => a.platform) : undefined
            }
            platform={effectivePlatform}
            traderKey={data.source_trader_id}
            tradingStyle={
              ((traderPerformance as Record<string, unknown> | null)?.tradingStyle as string) ??
              (traderPerformance as ExtendedPerformance | null)?.trading_style ??
              null
            }
          />
        </div>

        {/* Rank sparkline — 7-day rank trajectory */}
        {rankSparklineData.length >= 2 && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginTop: tokens.spacing[2],
              marginBottom: tokens.spacing[1],
            }}
          >
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
          linkedAccounts={
            hasMultipleAccounts
              ? linkedAccounts.map((a) => ({
                  platform: a.platform,
                  traderKey: a.traderKey,
                  handle: a.handle,
                }))
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
          onProRequired={() => {
            trackEvent('paywall_blocked', { source: 'trader_detail_tab' })
            router.push('/pricing')
          }}
          extraTabs={claimedUser ? ['posts'] : undefined}
          hideTabs={undefined}
        />

        {/* Pro upsell — compact banner for free users */}
        {!isPro && (
          <Link
            href="/pricing"
            onClick={() => trackEvent('click_go_pro_trader_detail')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              background:
                'linear-gradient(135deg, var(--color-accent-primary-10), var(--color-accent-secondary-10, var(--color-accent-primary-10)))',
              borderRadius: tokens.radius.md,
              margin: `${tokens.spacing[2]} 0`,
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            <Text
              style={{
                fontSize: tokens.typography.fontSize.sm,
                color: 'var(--color-accent-primary)',
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              {t('upgradeProStatsDesc')}
            </Text>
          </Link>
        )}

        {/* Tab Content — dims while loading account switch */}
        <div
          style={{
            opacity: traderLoading && !isPrimaryAccount ? 0.5 : 1,
            transition: 'opacity 0.2s ease',
            pointerEvents: traderLoading && !isPrimaryAccount ? 'none' : 'auto',
          }}
        >
          <div id="trader-tab-content">
            <SwipeableView
              activeIndex={tabKeys.indexOf(activeTab)}
              onIndexChange={(i) => handleTabChange(tabKeys[i])}
            >
              {/* Overview Tab — always mounted (primary tab, avoids skeleton flash on swipe-back) */}
              <Box
                id="panel-overview"
                role="tabpanel"
                aria-labelledby="tab-overview"
                style={{ minHeight: 200 }}
                className="tab-pane-enter"
              >
                <OverviewTab
                  data={data}
                  traderProfile={traderProfile}
                  traderPerformance={traderPerformance}
                  traderEquityCurve={
                    traderEquityCurve as
                      | import('@/app/(app)/u/[handle]/components/types').EquityCurveData
                      | undefined
                  }
                  traderSimilar={traderSimilar}
                  positionSummary={
                    traderData?.positionSummary as
                      | {
                          avgLeverage: number | null
                          longPositions: number | null
                          shortPositions: number | null
                        }
                      | null
                      | undefined
                  }
                  selectedPeriod={selectedPeriod}
                  hasMultipleAccounts={hasMultipleAccounts}
                  activeAccount={activeAccount}
                  aggregatedData={aggregatedData}
                  linkedAccounts={linkedAccounts}
                  currentUserId={currentUserId}
                  isOwner={isOwner}
                  isVerifiedTrader={isVerifiedTrader}
                  claimedUser={claimedUser}
                />
              </Box>

              {/* Stats Tab — not mounted until first visit (prevents skeleton flash in SwipeableView) */}
              <Box
                id="panel-stats"
                role="tabpanel"
                aria-labelledby="tab-stats"
                style={{ minHeight: 200 }}
                className="tab-pane-enter"
              >
                {visitedTabs.has('stats') ? (
                  <StatsTab
                    visited
                    stats={traderStats}
                    traderHandle={traderProfile?.handle || data.handle}
                    assetBreakdown={traderAssetBreakdown}
                    equityCurve={traderEquityCurve}
                    positionHistory={traderPositionHistory}
                    isPro={isPro}
                    onUnlock={handlePricingRedirect}
                  />
                ) : null}
              </Box>

              {/* Portfolio Tab — not mounted until first visit (prevents skeleton flash in SwipeableView) */}
              <Box
                id="panel-portfolio"
                role="tabpanel"
                aria-labelledby="tab-portfolio"
                style={{ minHeight: 200 }}
                className="tab-pane-enter"
              >
                {visitedTabs.has('portfolio') ? (
                  <PortfolioTab
                    visited
                    portfolio={traderPortfolio}
                    positionHistory={traderPositionHistory}
                    source={data.source}
                    isPro={isPro}
                    onUnlock={handlePricingRedirect}
                  />
                ) : null}
              </Box>

              {/* Posts Tab (only for claimed traders) — lazy mount on first visit */}
              {claimedUser && (
                <Box
                  id="panel-posts"
                  role="tabpanel"
                  aria-labelledby="tab-posts"
                  style={{ minHeight: 200 }}
                  className="tab-pane-enter"
                >
                  {visitedTabs.has('posts') && (
                    <Box
                      bg="secondary"
                      p={4}
                      radius="lg"
                      border="primary"
                      style={{ maxWidth: 900 }}
                    >
                      <Box
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: tokens.spacing[4],
                        }}
                      >
                        <Text size="lg" weight="black">
                          {t('posts')}
                        </Text>
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
            .profile-header {
              overflow: hidden !important;
              padding-left: ${tokens.spacing[3]} !important;
              padding-right: ${tokens.spacing[3]} !important;
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
