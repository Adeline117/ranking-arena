'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { fetcher } from '@/lib/hooks/useSWR'
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
import { JsonLd } from '@/app/components/Providers/JsonLd'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  combineSchemas,
} from '@/lib/seo'
import { BASE_URL } from '@/lib/constants/urls'
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
const LinkedAccountTabs = dynamic(() => import('@/app/components/trader/LinkedAccountTabs'), { ssr: false })
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

// TraderTabKey moved to ./hooks/useTraderTabs (re-imported below for compat)
import type { TraderTabKey } from './hooks/useTraderTabs'
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

export default function TraderProfileClient({ data, serverTraderData, claimedUser }: TraderProfileClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const { t, language: _language } = useLanguage()
  const { isPro } = useSubscription()
  const { userId: currentUserId } = useAuthSession()

  // Period URL ↔ store sync extracted into hook (see ./hooks/useTraderPeriodSync)
  const selectedPeriod = useTraderPeriodSync()

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
    const obs = new IntersectionObserver(
      ([entry]) => setShowMiniHeader(!entry.isIntersecting),
      { threshold: 0 }
    )
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
  const effectivePlatform = activeAccountRaw?.platform || searchParams?.get('platform') || data.source || ''
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
  const { data: traderData, error: traderError, isLoading: traderLoading } = useSWR<TraderPageData & {
    claim_status?: { is_verified: boolean; owner_id?: string | null; profile?: Record<string, unknown> }
    aggregate?: { aggregated: unknown; accounts: unknown[]; totalAccounts: number }
    rank_history?: { history: { date: string; rank: number; arena_score: number }[] }
  }>(
    traderApiUrl,
    traderFetcher,
    {
      revalidateOnFocus: false,
      // Pause auto-refresh when the tab is hidden to save bandwidth/CPU/battery.
      // SWR's default (refreshWhenHidden: false) skips ticks when hidden, but
      // returning 0 from this function halts the timer entirely. The interval
      // resumes automatically on visibilitychange because SWR re-evaluates
      // this function on revalidation.
      refreshInterval: () =>
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
          ? 0
          : 5 * 60 * 1000,
      refreshWhenHidden: false,
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

  // Now safe to call useLinkedAccounts — bundled aggregate is passed directly,
  // no ref gymnastics. On first render (before SWR resolves), undefined → hook
  // fires its own fetch. After SWR resolves, bundled data suppresses duplicate fetch.
  // The key improvement vs the old ref-based code: the suppression happens on the
  // first render where bundled data is available (not the render AFTER that).
  const { linkedAccounts, aggregatedData, hasMultipleAccounts } = useLinkedAccounts(
    data.source,
    data.source_trader_id,
    traderData?.aggregate,
  )

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

  // Stable references for derived SWR data — memoize so child components
  // wrapped in React.memo can bail out of re-render when traderData
  // identity changes but the underlying field hasn't.
  const traderProfile = useMemo(() => traderData?.profile ?? null, [traderData?.profile])
  const traderPerformance = useMemo(() => traderData?.performance ?? null, [traderData?.performance])
  const traderStats = useMemo(() => traderData?.stats ?? null, [traderData?.stats])
  const traderPortfolio = useMemo(() => traderData?.portfolio ?? [], [traderData?.portfolio])
  const traderPositionHistory = useMemo(() => traderData?.positionHistory ?? [], [traderData?.positionHistory])
  const traderEquityCurve = useMemo(() => traderData?.equityCurve, [traderData?.equityCurve])
  const traderAssetBreakdown = useMemo(() => traderData?.assetBreakdown, [traderData?.assetBreakdown])
  const traderSimilar = useMemo(() => traderData?.similarTraders ?? [], [traderData?.similarTraders])

  // Structured data for SEO — memoized so combineSchemas doesn't re-run on every
  // unrelated render (was being recomputed on every tab click, period switch, etc.)
  // Must be called before any early-return to satisfy rules-of-hooks.
  const structuredData = useMemo(() => combineSchemas(
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
  ), [data.handle, data.source_trader_id, data.source, data.roi, data.win_rate, data.max_drawdown, data.arena_score, data.avatar_url])

  // Loading state: only when SWR is loading AND no server fallback
  const isInitialLoading = traderLoading && !serverTraderData
  if (isInitialLoading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
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

  // (structuredData memoized earlier, before the early-return for loading state)

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
      {/* TopNav is rendered by the parent layout.tsx (server component) */}

      <Box className="page-container" style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6], paddingBottom: 100 }}>
        <Breadcrumb items={[
          { label: t('leaderboardBreadcrumb'), href: '/rankings' },
          { label: displayName },
        ]} />

        <TraderStaleBanner show={showStaleBanner} t={t} />
        <TraderPlatformDeadBanner show={!!data.is_platform_dead} source={data.source} t={t} />

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
          scoreConfidence={(traderPerformance as ExtendedPerformance | null)?.score_confidence as string ?? null}
          tradesCount={(traderPerformance as ExtendedPerformance | null)?.trades_count as number ?? null}
          rank={data.rank ?? null}
          currentUserId={currentUserId}
          isVerifiedTrader={isVerifiedTrader}
          isBot={data.source === 'web3_bot'}
          lastUpdated={traderData?.lastUpdated ?? traderData?.trackedSince}
          claimedBio={claimedUser?.bio || (traderProfile as Record<string, unknown> | null)?.bio as string | undefined}
          claimedAvatarUrl={claimedUser?.avatar_url}
          linkedAccountCount={hasMultipleAccounts ? linkedAccounts.length : undefined}
          linkedPlatforms={hasMultipleAccounts ? linkedAccounts.map(a => a.platform) : undefined}
          platform={effectivePlatform}
          traderKey={data.source_trader_id}
          tradingStyle={(traderPerformance as Record<string, unknown> | null)?.tradingStyle as string ?? (traderPerformance as ExtendedPerformance | null)?.trading_style ?? null}
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
          onProRequired={() => {
            trackEvent('paywall_blocked', { source: 'trader_detail_tab' })
            router.push('/pricing')
          }}
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
              <OverviewTab
                data={data}
                traderProfile={traderProfile as Record<string, unknown> | null}
                traderPerformance={traderPerformance as Record<string, unknown> | null}
                traderEquityCurve={traderEquityCurve as Record<string, Array<{ date: string; roi: number; pnl: number }>> | undefined}
                traderSimilar={traderSimilar}
                positionSummary={traderData?.positionSummary as { avgLeverage: number | null; longPositions: number | null; shortPositions: number | null } | null | undefined}
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
            )}
          </Box>

          {/* Stats Tab — lazy: only mount after first visit */}
          <Box style={{ minHeight: 200 }} className="tab-pane-enter">
            <StatsTab
              visited={visitedTabs.has('stats')}
              stats={traderStats as Record<string, unknown> | null}
              traderHandle={(traderProfile as Record<string, unknown> | null)?.handle as string || data.handle}
              assetBreakdown={traderAssetBreakdown}
              equityCurve={traderEquityCurve as { '90D': Array<{ date: string; roi: number; pnl: number }>; '30D': Array<{ date: string; roi: number; pnl: number }>; '7D': Array<{ date: string; roi: number; pnl: number }> } | undefined}
              positionHistory={traderPositionHistory}
              isPro={isPro}
              onUnlock={handlePricingRedirect}
            />
          </Box>

          {/* Portfolio Tab — lazy: only mount after first visit */}
          <Box style={{ minHeight: 200 }} className="tab-pane-enter">
            <PortfolioTab
              visited={visitedTabs.has('portfolio')}
              portfolio={traderPortfolio}
              positionHistory={traderPositionHistory}
              source={data.source}
              isPro={isPro}
              onUnlock={handlePricingRedirect}
            />
          </Box>

          {/* Posts Tab (only for claimed traders) */}
          {claimedUser && (
            <Box style={{ minHeight: 200 }} className="tab-pane-enter">
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
