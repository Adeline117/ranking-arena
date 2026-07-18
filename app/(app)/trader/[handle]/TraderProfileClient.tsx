'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import dynamic from 'next/dynamic'

const ProUpsellModal = dynamic(
  () => import('@/app/components/ui/ProGate').then((m) => ({ default: m.ProUpsellModal })),
  { ssr: false }
)
import { useQuery } from '@tanstack/react-query'
import { STALE_STANDARD, STALE_RELAXED } from '@/lib/hooks/cache-presets'
import { traderFetcher } from '@/lib/hooks/traderFetcher'
import { fetcher } from '@/lib/hooks/fetchers'
import type { TraderFirstScreen, TraderFirstScreenResponse } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'
import { tokens, alpha as colorAlpha } from '@/lib/design-tokens'
import { HOLDER_CHIP_STYLE } from '@/app/components/ranking/TraderRowStyles'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLinkedAccounts } from '@/lib/hooks/useLinkedAccounts'
import { useSourceCapabilities } from '@/lib/hooks/useSourceCapabilities'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { trackEvent } from '@/lib/analytics/track'
import {
  claimedTraderCanonicalHref,
  type ClaimedTraderIdentity,
} from '@/lib/identity/claimed-trader'
import { Box, Text } from '@/app/components/base'
// TopNav is now rendered by app/(app)/trader/[handle]/layout.tsx
// (was pulled into this client bundle unnecessarily before).
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import TraderTabs from '@/app/components/trader/TraderTabs'
import DataProvenanceBadge from '@/app/components/trader/DataProvenanceBadge'
import { type ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
// MarketCorrelationCard removed -- beta_btc/beta_eth/alpha never computed by pipeline (P0-5)
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { formatDisplayName, formatROI } from '@/app/components/ranking/utils'
import { getAvatarGradient } from '@/lib/utils/avatar'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
// JSON-LD structured data is emitted by the server component (page.tsx).
// Do NOT emit it here — that causes duplicate ProfilePage + BreadcrumbList.
import { RankSparkline } from '@/app/components/ranking/RankSparkline'

// Memoized tab components — each wraps its own subtree so SWR revalidations
// on one tab don't cause reconciliation of the others.
//
// Code-split: these render ONLY in the legacy (!isServing) branch, and even
// there they live inside the ssr:false SwipeableView — so they never SSR.
// Static imports shipped the entire legacy tab tree (Overview pulls
// AdvancedMetricsCard + multiple charts, ~hundreds of KiB) into EVERY trader
// page, including serving-mode pages (the majority, incl. the #1 trader) that
// never render them — the dominant source of the page's unused-JS / high TTI.
// dynamic() loads each tab's chunk only when it actually mounts.
const OverviewTab = dynamic(() => import('@/app/components/trader/tabs/OverviewTab'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})
const StatsTab = dynamic(() => import('@/app/components/trader/tabs/StatsTab'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})
const PortfolioTab = dynamic(() => import('@/app/components/trader/tabs/PortfolioTab'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})

const PostFeed = dynamic(() => import('@/app/components/post/PostFeed'), {
  ssr: false,
  loading: () => <RankingSkeleton />,
})

const SwipeableView = dynamic(() => import('@/app/components/ui/SwipeableView'), { ssr: false })
// Serving-mode body (ARENA_DATA_SPEC v1.2 §2.4) — only loaded for sources
// cut over to the arena.* read path; legacy bundles never pay for it.
const ServingProfilePanel = dynamic(
  () => import('@/app/components/trader/serving/ServingProfilePanel'),
  { ssr: false, loading: () => <RankingSkeleton /> }
)
const LinkedAccountTabs = dynamic(() => import('@/app/components/trader/LinkedAccountTabs'), {
  ssr: false,
  loading: () => <div style={{ minHeight: 48 }} />,
})
// P4 §2.3 lead-meta strip — same component the ServingProfilePanel uses, so the
// three-tab Overview surfaces copier-cap / margin-balance / last-trade etc.
const TraderMetaStrip = dynamic(() => import('@/app/components/trader/serving/TraderMetaStrip'), {
  ssr: false,
})
// P4 §2.5d on-chain insights (token PnL distribution / top tokens / PnL calendar)
const OnchainInsights = dynamic(() => import('@/app/components/trader/serving/OnchainInsights'), {
  ssr: false,
})
// M1: rich serving modules promoted to the DEFAULT three-tab path (were only on
// the ?threetab=0 escape hatch, invisible to normal users). All NULL-collapse,
// fed by servingTab.metaExtras (90d extras: risk_rating / style / liquidation /
// ability_scores / hold_histogram).
const SignalChips = dynamic(() => import('@/app/components/trader/serving/SignalChips'), {
  ssr: false,
})
const AbilityRadar = dynamic(() => import('@/app/components/trader/serving/AbilityRadar'), {
  ssr: false,
})
const RecentActivityCard = dynamic(
  () => import('@/app/components/trader/serving/RecentActivityCard'),
  { ssr: false }
)
const HoldingDistribution = dynamic(
  () => import('@/app/components/trader/serving/HoldingDistribution'),
  { ssr: false }
)
// Registry-driven superset metric grid (sharpe/sortino/mdd/risk ratios — incl.
// DEX Tier-0 derived). Was escape-hatch only; promoted to the default Stats tab
// so the captured risk metrics are actually visible. NULL-collapses.
const MetricGrid = dynamic(() => import('@/app/components/trader/serving/MetricGrid'), {
  ssr: false,
})
// M1: records section (positions/position-history/orders/transfers/copiers with
// keyset pagination) — the doc's required record surfaces. Was escape-hatch-only;
// promoted to the DEFAULT Stats tab so captured orders/transfers/copiers are
// actually visible. capability-gated + NULL-collapses.
const ServingRecordsSection = dynamic(
  () => import('@/app/components/trader/serving/ServingRecordsSection'),
  { ssr: false }
)
// M2-2a: eToro "Copiers Card" — copy-trading commercials (copiers/principal/
// min-copy/profit-share/growth) on the Overview decision zone. NULL-collapses.
const CopyTradingCard = dynamic(() => import('@/app/components/trader/serving/CopyTradingCard'), {
  ssr: false,
})
// M2-2d: asset-preference weights (eToro Trading-Card top instruments) — was
// escape-hatch-only, so normal users never saw it. NULL-collapses.
const AssetPreference = dynamic(() => import('@/app/components/trader/serving/AssetPreference'), {
  ssr: false,
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
  /** True when this account has an active read-only API authorization. */
  is_verified_data?: boolean
  is_platform_dead?: boolean
}

// TraderTabKey moved to ./hooks/useTraderTabs
import { useTraderPeriodSync } from './hooks/useTraderPeriodSync'
import { useTraderActiveAccount } from './hooks/useTraderActiveAccount'
import { useTraderTabs } from './hooks/useTraderTabs'
import { useServingTabData } from './hooks/useServingTabData'
import { useOnchainEnrichTrigger } from './hooks/useOnchainEnrichTrigger'
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

/** Map a Tier-A first screen onto the header data shape — the SAME field
 *  mapping the server component uses to build `servingTraderData` (page.tsx
 *  serving branch), so a client-side ?platform= account switch renders the
 *  header identically to a server-resolved page. */
function firstScreenToTraderData(
  fs: TraderFirstScreen,
  fallbackHandle: string,
  isVerifiedData = false
): UnregisteredTraderData {
  const entries = fs.entries ?? []
  const best =
    entries.find((e) => e.timeframe === 90) ?? entries.find((e) => e.timeframe === 30) ?? entries[0]
  const bestWinRate =
    best?.headlineWinRate ??
    (typeof best?.extras.win_rate === 'number' ? (best.extras.win_rate as number) : null)
  return {
    handle: fs.nickname ?? fallbackHandle,
    avatar_url: fs.avatarSrc,
    source: fs.source,
    source_trader_id: fs.exchangeTraderId,
    rank: best?.rank ?? null,
    roi: best?.headlineRoi ?? null,
    pnl: best?.headlinePnl?.value ?? null,
    win_rate: bestWinRate,
    max_drawdown: typeof best?.extras.mdd === 'number' ? (best.extras.mdd as number) : null,
    is_verified_data: isVerifiedData,
  }
}

interface TraderProfileClientProps {
  data: UnregisteredTraderData
  serverTraderData?: TraderPageData | null
  claimedUser?: ClaimedUserProfile | null
  /**
   * Exact account ownership resolved server-side from (source, traderId).
   * Canonicalization to /u/ is intentionally deferred to the browser because
   * the ISR server cannot observe an explicit ?platform= variant.
   */
  claimedTraderIdentity?: ClaimedTraderIdentity | null
  /** ARENA_DATA_SPEC v1.2 serving cutover: 'serving' reads arena.* via the
   *  first-screen/core/records contracts. Default 'legacy' keeps this
   *  component byte-identical to the pre-cutover behavior. */
  dataMode?: 'legacy' | 'serving'
  servingFirstScreen?: import('@/lib/data/serving/types').TraderFirstScreen | null
  servingCapability?: import('@/lib/data/serving/types').SourceCapability | null
  /** U2-12: similar traders computed server-side for serving sources (the
   *  serving /core data path carries none, so OverviewTab hid the module).
   *  Same shape as the legacy bridge output; fed into effSimilar below. */
  serverSimilarTraders?: TraderPageData['similarTraders']
  /** Per-TF Arena Score sub-scores + trading style from leaderboard_ranks
   *  (2026-07-09): the serving /core path carries raw stats only, so
   *  ScoreBreakdownSection and the header style tag were empty in serving mode. */
  servingScores?: ServingScoreRow[]
}

export interface ServingScoreRow {
  season_id: string
  arena_score: number | null
  arena_score_v3: number | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | number | null
  trading_style: string | null
  style_confidence: number | null
  avg_holding_hours: number | null
}

export default function TraderProfileClient({
  data: serverData,
  serverTraderData,
  claimedUser,
  claimedTraderIdentity,
  dataMode = 'legacy',
  servingFirstScreen: serverFirstScreen,
  servingCapability: serverCapability,
  serverSimilarTraders,
  servingScores,
}: TraderProfileClientProps) {
  // ROOT-CAUSE FIX (2026-06-11): key serving mode off dataMode ALONE, not the
  // presence of servingFirstScreen. A serving source must never fall back to the
  // legacy /api/traders endpoint (which 404s for arena.* sources and renders a
  // full-page "Trader Not Found" over an HTTP-200 page). The server now always
  // ships a non-null servingFirstScreen for serving sources, but this guard is
  // the belt-and-suspenders: even a null first-screen keeps us out of legacy mode.
  const isServing = dataMode === 'serving'
  const router = useRouter()
  const searchParams = useSearchParams()
  const routeParams = useParams<{ handle: string }>()
  const { t, language: _language } = useLanguage()
  const { isPro } = useSubscription()
  const { userId: currentUserId } = useAuthSession()

  // ── ?platform= account disambiguation (serving mode) ─────────────────────
  // ROOT-CAUSE FIX (2026-07-02): the page is ISR-static, so the server
  // component CANNOT read searchParams (one cached HTML serves every
  // ?platform= variant) and arena_resolve_trader ran WITHOUT a platform hint.
  // For a handle that exists on multiple serving sources (okx_futures rank-16
  // and okx_spot share the same exchange_trader_id) the server may have
  // resolved the WRONG account — the header then shows "OKX Spot / $0" for an
  // okx_futures leaderboard link. Detect the mismatch here, VALIDATE the URL
  // platform against the serving resolver (a stale/forged ?platform= must
  // never break a good page → 404 keeps the server's account), then switch
  // the WHOLE page — header numbers, capability, and every /core + /records
  // fetch — onto the requested account.
  const urlPlatform = searchParams?.get('platform') ?? null
  const rawUrlHandle = typeof routeParams?.handle === 'string' ? routeParams.handle : ''
  const urlHandle = (() => {
    try {
      return decodeURIComponent(rawUrlHandle)
    } catch {
      // Intentionally swallowed: malformed URI encoding, use raw handle as-is
      // (same behavior as the server component).
      return rawUrlHandle
    }
  })()
  const platformMismatch =
    isServing && !!urlPlatform && !!urlHandle && urlPlatform !== serverData.source
  const { data: accountOverride } = useQuery<TraderFirstScreenResponse | null>({
    queryKey: ['trader-first-screen', urlHandle, urlPlatform],
    queryFn: async () => {
      try {
        const res = await fetcher<ApiSuccessResponse<TraderFirstScreenResponse>>(
          `/api/traders/${encodeURIComponent(urlHandle)}/first-screen?source=${encodeURIComponent(urlPlatform ?? '')}`
        )
        return res.data
      } catch (err) {
        // 404 = the handle does not exist on the requested platform (stale or
        // forged link) → null keeps the server-resolved account rendering.
        if ((err as Error & { status?: number }).status === 404) return null
        throw err
      }
    },
    enabled: platformMismatch,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => {
      if ((error as Error & { status?: number }).status === 404) return false
      return failureCount < 2
    },
  })
  // Adopt ONLY a validated account for the requested platform. The
  // /first-screen route resolves via arena_resolve_trader, whose WHERE already
  // constrains the row to the requested source by EITHER its arena slug OR its
  // legacy platform alias, and 404s otherwise — so a non-null response is
  // already the validated account for urlPlatform. Do NOT re-compare
  // firstScreen.source === urlPlatform here: for legacy-alias platforms the
  // response carries the arena slug (e.g. 'bitunix_futures') while urlPlatform
  // is the alias the search href uses (e.g. 'bitunix'), and that mismatch was
  // silently dropping the override so ?platform= disambiguation fell back to
  // the (possibly wrong) server-resolved account on bitunix/xt/blofin/btcc.
  const override = platformMismatch && accountOverride ? accountOverride : null
  const servingFirstScreen = override ? override.firstScreen : serverFirstScreen
  const isVerifiedData = override
    ? override.is_verified_data
    : (serverData.is_verified_data ?? false)
  const data = useMemo<UnregisteredTraderData>(
    () =>
      override
        ? firstScreenToTraderData(override.firstScreen, urlHandle, override.is_verified_data)
        : serverData,
    [override, serverData, urlHandle]
  )

  // Claimed profiles use /u/... as their canonical route, but the ISR server
  // cannot safely redirect because it cannot see ?platform=. Wait until the
  // browser has either matched the exact server source or validated a differing
  // source/alias through /first-screen, then compare the full account identity.
  const claimedCanonicalHref = claimedTraderCanonicalHref({
    claimedIdentity: claimedTraderIdentity,
    visibleIdentity: {
      source: data.source,
      traderId: data.source_trader_id,
    },
    requestedPlatform: urlPlatform,
    requestedPlatformValidated: Boolean(override),
  })
  useEffect(() => {
    if (claimedCanonicalHref) router.replace(claimedCanonicalHref)
  }, [claimedCanonicalHref, router])

  // ROOT-CAUSE FIX (2026-07-02): the page is ISR-static, and the server's
  // cachedCapabilities() races a 2s timeout → {} — a slow render bakes
  // servingCapability:null INTO the cached HTML for the whole revalidate
  // window. Null capability permanently disables every /records fetch in
  // useServingTabData (capability?.surfaces?.positions is false), so the
  // Portfolio tab rendered "No portfolio data available" while
  // /api/traders/:id/records returned rows. Fall back to the client-fetched
  // near-static capability matrix ONLY when the server prop is missing.
  const serverOrOverrideCapability = override ? override.capability : serverCapability
  const { capabilities: clientCapabilities } = useSourceCapabilities(
    isServing && !serverOrOverrideCapability
  )
  const servingCapability = serverOrOverrideCapability ?? clientCapabilities?.[data.source] ?? null

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
  const [proUpsellOpen, setProUpsellOpen] = useState(false)
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
    // Serving mode never touches the legacy detail endpoint — core modules
    // and records come from /core and /records via ServingProfilePanel.
    enabled: !isServing,
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

  // U3-1c: A 404 from the supplementary /api/traders fetch must NOT blank an
  // already-SSR-rendered page. Reaching this client means the server DID resolve
  // the trader (else generateMetadata would have 404'd before streaming) and
  // shipped identity/scores in `serverData`. The supplementary fetch only ADDS
  // claim/aggregate/rank_history — a 404 means those extras are unavailable, not
  // that the trader is missing. Warn once so the degradation stays observable.
  useEffect(() => {
    const status = (traderError as (Error & { status?: number }) | null)?.status
    if (traderError && status === 404 && (serverData?.source_trader_id || serverData?.handle)) {
      console.warn(
        '[trader] supplementary /api/traders 404 — keeping SSR-rendered data (claim/aggregate/rank_history unavailable)',
        { handle: serverData?.handle, source: serverData?.source }
      )
    }
  }, [traderError, serverData?.source_trader_id, serverData?.handle, serverData?.source])

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

  // P4 three-tab unification (spec §4): every serving source renders the SAME
  // Overview/Stats/Portfolio tabs as legacy (fed via legacy-adapter), instead of
  // the trimmed ServingProfilePanel. Now the DEFAULT for serving — browse-verified
  // across CEX full-surface / board-backfill / onchain (§2.5d). Escape hatch:
  // ?threetab=0 or NEXT_PUBLIC_SERVING_THREE_TAB=0 falls back to the panel (kept
  // for instant rollback until the panel code is retired). The hook is called
  // unconditionally (hooks rule); `enabled` gates every fetch off for legacy.
  const useThreeTab =
    isServing &&
    searchParams.get('threetab') !== '0' &&
    process.env.NEXT_PUBLIC_SERVING_THREE_TAB !== '0'
  const servingTab = useServingTabData(
    {
      source: data.source,
      exchangeTraderId: data.source_trader_id,
      nickname: servingFirstScreen?.nickname ?? data.handle ?? null,
      avatarSrc: servingFirstScreen?.avatarSrc ?? null,
      entries: servingFirstScreen?.entries,
      scores: servingScores,
    },
    servingCapability ?? null,
    useThreeTab
  )
  // 即看即算: for a web3 wallet with no on-chain data yet, compute it on demand
  // (bounded) instead of waiting for the 12h rotation, then refetch.
  const onchainEnrichmentState = useOnchainEnrichTrigger({
    source: data.source,
    exchangeTraderId: data.source_trader_id,
    extras: servingTab.metaExtras,
    enabled: useThreeTab,
    loaded: useThreeTab && !servingTab.loading,
  })

  // Effective tab props: serving-derived under the flag, legacy otherwise.
  const effProfile = useThreeTab ? servingTab.traderProfile : traderProfile
  const effPerformance = useThreeTab ? servingTab.traderPerformance : traderPerformance
  const effStats = useThreeTab ? servingTab.traderStats : traderStats
  const effPortfolio = useThreeTab ? servingTab.traderPortfolio : traderPortfolio
  const effPositionHistory = useThreeTab ? servingTab.traderPositionHistory : traderPositionHistory
  const effEquityCurve = useThreeTab ? servingTab.traderEquityCurve : traderEquityCurve
  const effAssetBreakdown = useThreeTab ? servingTab.traderAssetBreakdown : traderAssetBreakdown
  // U2-12: serving sources have no similarTraders in traderData (the /core path
  // omits them) → OverviewTab's `traderSimilar.length > 0` guard hid the module.
  // Under three-tab (serving default) use the server-computed list; legacy keeps
  // its React-Query-derived traderSimilar untouched.
  const effSimilar = useMemo(
    () => (useThreeTab ? (serverSimilarTraders ?? []) : traderSimilar),
    [useThreeTab, serverSimilarTraders, traderSimilar]
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
  // U3-1c: NEVER show a full-page 404 when the server already resolved this trader
  // and shipped identity in `serverData`. A supplementary /api/traders 404 in that
  // case means only the claim/aggregate/rank_history extras are unavailable — the
  // page must degrade to the SSR-rendered content, not dead-end (this was 92% of
  // search clicks). The genuine "trader does not exist" case is 404'd server-side
  // in generateMetadata, before this client ever renders.
  const hasServerIdentity = !!(serverData?.source_trader_id || serverData?.handle)
  const isNotFound =
    traderError &&
    !traderData &&
    !hasServerIdentity &&
    (traderError as Error & { status?: number }).status === 404
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
                background: 'var(--color-brand-deep)',
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

  // Error state: only when SWR errored AND no cached data available AND the server
  // gave us no identity to fall back on. U3-1c: with server identity present we
  // degrade to the SSR-rendered content (stale banner below) instead of blanking.
  if (traderError && !traderData && !hasServerIdentity) {
    return <TraderProfileError t={t} errorMessage={traderError?.message} />
  }

  // #24: Stale data banner — show when SWR errored but cached/stale (or SSR) data
  // is still available. Also covers the U3-1c degrade path (traderData null but
  // serverData identity present).
  const showStaleBanner = !!traderError && (!!traderData || hasServerIdentity)

  return (
    <Box
      className="trader-page-container"
      style={{
        minHeight: '100vh',
        background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${colorAlpha(tokens.colors.bg.secondary, 19)} 100%)`,
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
                src={avatarSrc(data.avatar_url)}
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

        {/* Rank sparkline — 7-day rank trajectory.
            CLS 修复(Lighthouse 2026-07-10, trader CLS 0.144 元凶):此条此前等
            客户端 rank-history fetch 到达才渲染,出现瞬间把下方 ExchangeLinksBar/
            tabs/profile-grid 整体下推 ~34px(两次 grid shift 合计 0.098)。
            服务端已知 rank(data.rank)时首帧即预留固定高度,数据到了往里填——
            无 rank 的交易员照旧不渲染,不留空洞。 */}
        {(rankSparklineData.length >= 2 || data.rank != null) && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginTop: tokens.spacing[2],
              marginBottom: tokens.spacing[1],
              minHeight: 24,
            }}
          >
            {rankSparklineData.length >= 2 && (
              <>
                <Text size="xs" color="tertiary">
                  {t('rankTrend')}
                </Text>
                <RankSparkline data={rankSparklineData} width={80} height={24} />
              </>
            )}
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

        {/* Serving mode (spec §2.4): the body below the header reads from
            arena.* via /core + /records — legacy tabs are not rendered. */}
        {isServing && !useThreeTab && servingFirstScreen && (
          <ServingProfilePanel
            firstScreen={servingFirstScreen}
            capability={servingCapability ?? null}
          />
        )}

        {/* Tabs — legacy sources always; serving sources under the P4 flag */}
        {(!isServing || useThreeTab) && (
          <TraderTabs
            activeTab={activeTab}
            onTabChange={handleTabChange}
            isPro={isPro}
            onProRequired={() => {
              // Modal instead of hard navigation: keep the user on the trader
              // page while presenting the upsell.
              trackEvent('paywall_blocked', { source: 'trader_detail_tab' })
              setProUpsellOpen(true)
            }}
            extraTabs={claimedUser ? ['posts'] : undefined}
            hideTabs={undefined}
          />
        )}
        <ProUpsellModal
          open={proUpsellOpen}
          onClose={() => setProUpsellOpen(false)}
          featureKey="upgradeProStatsDesc"
        />

        {/* Tab Content — dims while loading account switch */}
        {(!isServing || useThreeTab) && (
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
                  {/* A1 data-authenticity provenance (Myfxbook model). The
                      verification value is sourced from the active read-only
                      API authorization for the account currently on screen. */}
                  <Box style={{ marginBottom: tokens.spacing[3] }}>
                    <DataProvenanceBadge
                      verified={isVerifiedData}
                      // Tracked chip doubles as the verify-upgrade entry (A1
                      // adoption pull) — same URL shape as ClaimTraderButton.
                      claimHref={
                        isVerifiedData
                          ? undefined
                          : `/claim?trader=${encodeURIComponent(data.source_trader_id)}&source=${encodeURIComponent(data.source)}&handle=${encodeURIComponent(data.handle || data.source_trader_id)}&step=verify`
                      }
                    />
                  </Box>
                  {/* §2.3 lead-meta strip — serving only; NULL-collapses to
                      null when no meta fields resolve (legacy renders nothing). */}
                  {useThreeTab && (
                    <Box style={{ marginBottom: tokens.spacing[3] }}>
                      <TraderMetaStrip
                        extras={servingTab.metaExtras}
                        currency={servingTab.currency}
                      />
                      {/* M1: risk rating / style tags / last-liquidation chips +
                          MEXC ability radar — surfaced on the default path. Both
                          NULL-collapse when the source lacks the extras. */}
                      <SignalChips source={data.source} extras={servingTab.metaExtras} />
                      {/* M2-2a: eToro Copiers-Card — the "should I copy" commercial
                          facts, grouped instead of dumped into the metric grid. */}
                      <Box style={{ marginTop: tokens.spacing[3] }}>
                        <CopyTradingCard
                          extras={servingTab.metaExtras}
                          currency={servingTab.currency}
                        />
                      </Box>
                      <AbilityRadar extras={servingTab.metaExtras} />
                      {/* P2线 2026-07-09: order_records 此前只埋在 Stats 深处 —
                          Overview 加最近成交预览(共享 React Query 缓存,零重复网络;
                          能力关/无数据整卡 NULL-collapse)。 */}
                      <RecentActivityCard
                        source={data.source}
                        exchangeTraderId={data.source_trader_id}
                        enabled={useThreeTab && Boolean(servingCapability?.surfaces?.orders)}
                      />
                    </Box>
                  )}
                  <OverviewTab
                    data={data}
                    traderProfile={effProfile}
                    traderPerformance={effPerformance}
                    traderEquityCurve={
                      effEquityCurve as
                        | import('@/app/(app)/u/[handle]/components/types').EquityCurveData
                        | undefined
                    }
                    traderSimilar={effSimilar}
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
                    <Box
                      style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}
                    >
                      {/* §2.5d on-chain insights — serving only; NULL-collapses
                          when the source has no token/calendar extras. */}
                      {useThreeTab && (
                        <OnchainInsights
                          extras={servingTab.metaExtras}
                          currency={servingTab.currency}
                          enrichmentState={onchainEnrichmentState}
                        />
                      )}
                      {/* M1: holding-duration histogram (MEXC etc.) on default
                          Stats tab. NULL-collapses when no hold_histogram. */}
                      {useThreeTab && <HoldingDistribution extras={servingTab.metaExtras} />}
                      {/* M2-2d: asset-preference weights (top traded instruments). */}
                      {useThreeTab && <AssetPreference extras={servingTab.metaExtras} />}
                      {/* Holder tag: win% NULL-collapses in the grid for a
                          confirmed zero-close-trade wallet (win_rate null +
                          total_positions 0), so the grid gives no signal there.
                          Surface the same "Holder" chip as the rankings so the
                          detail page reads intentional, not "missing win%". */}
                      {useThreeTab &&
                        servingTab.gridStats.win_rate == null &&
                        servingTab.gridStats.total_positions === 0 && (
                          <div style={{ margin: `${tokens.spacing[2]} 0` }}>
                            <span title={t('holderTooltip')} style={HOLDER_CHIP_STYLE}>
                              {t('holderBadge')}
                            </span>
                          </div>
                        )}
                      {/* M1/M2: registry superset metric grid (sharpe/sortino/mdd/
                          risk ratios — incl. DEX Tier-0 derived). Was escape-hatch
                          only; NULL-collapses per source capability. */}
                      {useThreeTab && (
                        <MetricGrid
                          stats={servingTab.gridStats}
                          capabilityMetrics={servingTab.gridCapabilityMetrics}
                          currency={servingTab.currency}
                        />
                      )}
                      {/* M1: doc-required record surfaces (positions/history/
                          orders/transfers/copiers) on the DEFAULT Stats tab —
                          not just the ?threetab=0 escape hatch. NULL-collapses. */}
                      {useThreeTab && (
                        <ServingRecordsSection
                          source={data.source}
                          exchangeTraderId={data.source_trader_id}
                          capability={servingCapability ?? null}
                          tf={90}
                          exchangeName={servingCapability?.exchangeName}
                          excludeKinds={['positions', 'position_history']}
                        />
                      )}
                      <StatsTab
                        visited
                        stats={effStats}
                        traderHandle={effProfile?.handle || data.handle}
                        assetBreakdown={effAssetBreakdown}
                        equityCurve={effEquityCurve}
                        positionHistory={effPositionHistory}
                        isPro={isPro}
                        onUnlock={handlePricingRedirect}
                      />
                    </Box>
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
                      portfolio={effPortfolio}
                      positionHistory={effPositionHistory}
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
        )}

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
