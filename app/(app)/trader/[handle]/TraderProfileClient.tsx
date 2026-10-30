'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter, useParams, usePathname, useSearchParams } from 'next/navigation'
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
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'
import { tokens, alpha as colorAlpha } from '@/lib/design-tokens'
import { HOLDER_CHIP_STYLE } from '@/app/components/ranking/TraderRowStyles'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLinkedAccounts } from '@/lib/hooks/useLinkedAccounts'
import { useSourceCapabilities } from '@/lib/hooks/useSourceCapabilities'
import { trackEvent } from '@/lib/analytics/track'
import {
  claimedTraderCanonicalHref,
  type ClaimedTraderIdentity,
} from '@/lib/identity/claimed-trader'
import { buildTraderClaimReturnPath } from '@/lib/auth/trader-claim-login'
import { Box, Text } from '@/app/components/base'
// TopNav is now rendered by app/(app)/trader/[handle]/layout.tsx
// (was pulled into this client bundle unnecessarily before).
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import TraderHeader from '@/app/components/trader/TraderHeader'
import LinkedAccountStatus from '@/app/components/trader/LinkedAccountStatus'
import {
  isExactSourceNotServingError,
  parseExactTraderFirstScreenResponse,
  parseExactRankHistory,
  resolveLinkedAccountViewScope,
  resolveTraderHeaderAccountMetrics,
  traderDetailMatchesLinkedAccount,
  traderDetailMatchesRequestedRoute,
} from '@/app/components/trader/linked-account-view'
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
import {
  LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  PUBLIC_PROFILE_HISTORY_QUERY_EPOCH,
  quarantineLegacyPositionHistory,
} from '@/lib/data/trader/history-quarantine'

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
import { resolveTraderProfileOwnership } from './profile-ownership'
import {
  parseExactTraderClaimEnvelope,
  resolveTraderClaimSources,
  type ExactTraderClaimData,
} from './profile-claim-source'

// NO_PORTFOLIO_PLATFORMS removed — Portfolio tab shown for ALL platforms
// When no position data exists, the Portfolio component shows an empty state
type TraderPageData = import('@/app/(app)/u/[handle]/components/types').TraderPageData
const EMPTY_SIMILAR_TRADERS: NonNullable<TraderPageData['similarTraders']> = []
const EMPTY_LEGACY_POSITION_HISTORY: NonNullable<TraderPageData['positionHistory']> = []

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
  const pathname = usePathname()
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
  // platform against the serving resolver. A stale/forged selector is removed
  // before the server account can render under the wrong requested URL; then switch
  // the WHOLE page — header numbers, capability, and every /core + /records
  // fetch — onto the requested account.
  const platformValues = searchParams.getAll('platform')
  const platformSelectorInvalid =
    platformValues.length > 1 ||
    (platformValues.length === 1 &&
      (platformValues[0].length === 0 ||
        platformValues[0].length > 64 ||
        platformValues[0] !== platformValues[0].trim()))
  const urlPlatform =
    platformValues.length === 1 && !platformSelectorInvalid ? platformValues[0] : null
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
  const platformMismatch = !!urlPlatform && !!urlHandle && urlPlatform !== serverData.source
  const {
    data: accountOverride,
    error: accountOverrideError,
    isFetchedAfterMount: accountOverrideFetchedAfterMount,
    isFetching: accountOverrideFetching,
    fetchStatus: accountOverrideFetchStatus,
  } = useQuery<unknown>({
    queryKey: ['trader-first-screen', urlHandle, urlPlatform],
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<unknown>>(
        `/api/traders/${encodeURIComponent(urlHandle)}/first-screen?source=${encodeURIComponent(urlPlatform ?? '')}`
      )
      return res.data
    },
    enabled: platformMismatch,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
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
  const accountOverrideStatus = (accountOverrideError as (Error & { status?: number }) | null)
    ?.status
  const accountOverrideSettledAfterMount =
    accountOverrideFetchedAfterMount &&
    accountOverrideFetchStatus === 'idle' &&
    !accountOverrideFetching
  const exactRouteOverrideRequest =
    urlPlatform && urlHandle
      ? ({ kind: 'route', platform: urlPlatform, handle: urlHandle } as const)
      : null
  const parsedAccountOverride = exactRouteOverrideRequest
    ? parseExactTraderFirstScreenResponse(accountOverride, exactRouteOverrideRequest)
    : null
  const accountOverrideMatchesRequest = Boolean(
    platformMismatch &&
    accountOverrideSettledAfterMount &&
    !accountOverrideError &&
    parsedAccountOverride
  )
  const override = accountOverrideMatchesRequest ? parsedAccountOverride : null
  const accountOverrideAllowsLegacy = Boolean(
    exactRouteOverrideRequest &&
    accountOverrideSettledAfterMount &&
    isExactSourceNotServingError(accountOverrideError, exactRouteOverrideRequest)
  )
  const accountOverrideServingNotFound = Boolean(
    accountOverrideSettledAfterMount &&
    accountOverrideStatus === 404 &&
    !accountOverrideAllowsLegacy
  )
  const legacyPlatformOverrideUrl =
    platformMismatch && accountOverrideAllowsLegacy && urlPlatform
      ? `/api/traders/${encodeURIComponent(urlHandle)}?source=${encodeURIComponent(urlPlatform)}`
      : null
  const {
    data: legacyPlatformOverrideResponse,
    error: legacyPlatformOverrideError,
    isFetchedAfterMount: legacyPlatformOverrideFetchedAfterMount,
    isFetching: legacyPlatformOverrideFetching,
    fetchStatus: legacyPlatformOverrideFetchStatus,
  } = useQuery<TraderPageData>({
    queryKey: [
      'trader-platform-legacy-override',
      PUBLIC_PROFILE_HISTORY_QUERY_EPOCH,
      urlHandle,
      urlPlatform,
    ],
    queryFn: () => traderFetcher<TraderPageData>(legacyPlatformOverrideUrl!),
    enabled: Boolean(legacyPlatformOverrideUrl),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: (failureCount, error) => {
      if ((error as Error & { status?: number }).status === 404) return false
      return failureCount < 2
    },
  })
  const legacyPlatformOverrideMatchesRequest = Boolean(
    accountOverrideAllowsLegacy &&
    legacyPlatformOverrideResponse &&
    legacyPlatformOverrideFetchedAfterMount &&
    legacyPlatformOverrideFetchStatus === 'idle' &&
    !legacyPlatformOverrideFetching &&
    !legacyPlatformOverrideError &&
    urlPlatform &&
    traderDetailMatchesRequestedRoute(legacyPlatformOverrideResponse, urlPlatform, urlHandle)
  )
  const legacyPlatformOverride = legacyPlatformOverrideMatchesRequest
    ? legacyPlatformOverrideResponse
    : null
  const baseIdentityReady =
    (!platformMismatch && !platformSelectorInvalid) ||
    Boolean(override) ||
    Boolean(legacyPlatformOverride)
  const firstScreenMalformed = Boolean(
    platformMismatch &&
    accountOverrideSettledAfterMount &&
    !accountOverrideError &&
    (!accountOverride || !accountOverrideMatchesRequest)
  )
  const legacyPlatformOverrideStatus = (
    legacyPlatformOverrideError as (Error & { status?: number }) | null
  )?.status
  const legacyPlatformOverrideRejected = Boolean(
    accountOverrideAllowsLegacy &&
    legacyPlatformOverrideFetchedAfterMount &&
    legacyPlatformOverrideFetchStatus === 'idle' &&
    !legacyPlatformOverrideFetching &&
    !legacyPlatformOverrideMatchesRequest &&
    (!legacyPlatformOverrideError || legacyPlatformOverrideStatus === 404)
  )
  const platformOverrideRejected = Boolean(
    platformSelectorInvalid ||
    firstScreenMalformed ||
    accountOverrideServingNotFound ||
    legacyPlatformOverrideRejected
  )

  // A stale/forged ?platform= must never render the ISR account under the
  // requested platform URL. Withdraw the mismatched account immediately, then
  // remove only the rejected selector so the exact server route can recover.
  useEffect(() => {
    if (!platformOverrideRejected) return
    const params = new URLSearchParams(searchParams.toString())
    params.delete('platform')
    const query = params.toString()
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false })
  }, [pathname, platformOverrideRejected, router, searchParams])

  const servingFirstScreen = override
    ? override.firstScreen
    : legacyPlatformOverride
      ? null
      : baseIdentityReady
        ? serverFirstScreen
        : null
  const isVerifiedData = override
    ? override.is_verified_data
    : legacyPlatformOverride
      ? false
      : baseIdentityReady
        ? (serverData.is_verified_data ?? false)
        : false
  const data: UnregisteredTraderData = (() => {
    if (override) {
      return firstScreenToTraderData(override.firstScreen, urlHandle, override.is_verified_data)
    }
    if (legacyPlatformOverride?.profile) {
      const profile = legacyPlatformOverride.profile
      const performance = legacyPlatformOverride.performance as ExtendedPerformance | null
      return {
        handle: profile.handle || urlHandle,
        avatar_url: profile.avatar_url ?? null,
        profile_url: profile.profile_url ?? null,
        source: profile.source || urlPlatform || '',
        source_trader_id: profile.trader_key || profile.id,
        rank: null,
        arena_score: performance?.arena_score_90d ?? performance?.arena_score ?? null,
        roi: performance?.roi_90d ?? null,
        pnl: performance?.pnl ?? null,
        win_rate: performance?.win_rate ?? null,
        max_drawdown: performance?.max_drawdown ?? null,
        is_verified_data: false,
      }
    }
    return baseIdentityReady
      ? serverData
      : {
          handle: urlHandle,
          source: urlPlatform ?? '',
          source_trader_id: urlHandle,
          rank: null,
          arena_score: null,
          roi: null,
          pnl: null,
          win_rate: null,
          max_drawdown: null,
          is_verified_data: false,
        }
  })()
  // Claimed/social props were resolved for the ISR subject. They cannot be
  // reused for a platform override, even after its first-screen identity is
  // valid, because the response carries no matching social subject proof.
  const routeClaimedUser =
    override || legacyPlatformOverride || !baseIdentityReady ? null : claimedUser

  // Claimed profiles use /u/... as their canonical route, but the ISR server
  // cannot safely redirect because it cannot see ?platform=. Wait until the
  // browser has either matched the exact server source or validated a differing
  // source/alias through /first-screen, then compare the full account identity.
  const routeClaimedCanonicalHref = claimedTraderCanonicalHref({
    claimedIdentity: claimedTraderIdentity,
    visibleIdentity: {
      source: data.source,
      traderId: data.source_trader_id,
    },
    requestedPlatform: urlPlatform,
    requestedPlatformValidated: Boolean(override || legacyPlatformOverride),
  })
  // Period URL ↔ store sync extracted into hook (see ./hooks/useTraderPeriodSync)
  const selectedPeriod = useTraderPeriodSync()

  // Track trader profile page view (funnel: browse → trader detail)
  useEffect(() => {
    trackEvent('view_trader', {
      platform: data.source,
      handle: data.handle || data.source_trader_id,
    })
  }, [data.source, data.handle, data.source_trader_id])

  const [proUpsellOpen, setProUpsellOpen] = useState(false)

  // Active account state machine extracted into hook (./hooks/useTraderActiveAccount).
  // Owns: activeAccount string, parsed activeAccountRaw, change handler. Critical
  // invariant: parses platform:traderKey inline without needing linkedAccounts.
  const { activeAccount, activeAccountRaw, isAccountParamInvalid, handleAccountChange } =
    useTraderActiveAccount()

  const {
    linkedAccounts,
    aggregatedData,
    hasMultipleAccounts,
    isLoading: linkedAccountsLoading,
    authoritativeReady: linkedAccountsReady,
    error: linkedAccountsError,
  } = useLinkedAccounts(
    baseIdentityReady ? data.source : undefined,
    baseIdentityReady ? data.source_trader_id : undefined
  )
  const linkedMembershipSubject = baseIdentityReady
    ? JSON.stringify([data.source, data.source_trader_id])
    : null
  const [aggregateIntentSubject, setAggregateIntentSubject] = useState<string | null>(null)
  const preserveAggregateIntent =
    linkedMembershipSubject !== null && aggregateIntentSubject === linkedMembershipSubject
  const linkedAccountScope = resolveLinkedAccountViewScope({
    selectionEnabled: true,
    requestedAccount: activeAccountRaw,
    malformedSelection: isAccountParamInvalid,
    authoritativeReady: linkedAccountsReady,
    accounts: linkedAccounts,
    preserveAggregateIntent,
  })
  useEffect(() => {
    if (!linkedAccountsReady || !linkedMembershipSubject) return
    setAggregateIntentSubject((current) => {
      if (hasMultipleAccounts) return linkedMembershipSubject
      return current === linkedMembershipSubject ? null : current
    })
  }, [hasMultipleAccounts, linkedAccountsReady, linkedMembershipSubject])
  const validatedActiveAccount = linkedAccountScope.selectedAccount
  const isPrimaryAccount = linkedAccountScope.mode === 'primary'
  // The server-resolved social identity belongs only to the unambiguous route
  // account. Aggregate, unresolved and explicitly selected scopes must not
  // inherit its owner, posts or registered-user actions. A selected account can
  // regain those surfaces only after an exact subject-bound social read exists.
  const visibleClaimedUser = isPrimaryAccount ? routeClaimedUser : null
  const suppressAccountMetrics = linkedAccountScope.suppressAccountMetrics || !baseIdentityReady

  // Canonicalize only after live membership proves this is one unambiguous
  // route account. Never discard an explicit linked-account deep link, and do
  // not race a still-pending relation that may resolve to the aggregate scope.
  const claimedCanonicalHref =
    linkedAccountsReady && isPrimaryAccount && searchParams.getAll('account').length === 0
      ? routeClaimedCanonicalHref
      : null
  useEffect(() => {
    if (claimedCanonicalHref) router.replace(claimedCanonicalHref)
  }, [claimedCanonicalHref, router])

  // Probe the serving first-screen boundary for every linked subject. Only a
  // fresh, request-bound `source_not_serving` proof enables the legacy detail
  // fallback; a missing trader on a cut-over source remains closed. Cached
  // responses stay hidden until this mount revalidates.
  const selectedServingUrl = validatedActiveAccount
    ? `/api/traders/${encodeURIComponent(validatedActiveAccount.traderKey)}/first-screen?source=${encodeURIComponent(validatedActiveAccount.platform)}`
    : null
  const {
    data: selectedServingResponse,
    error: selectedServingError,
    isLoading: selectedServingLoading,
    isFetchedAfterMount: selectedServingFetchedAfterMount,
    isFetching: selectedServingFetching,
    fetchStatus: selectedServingFetchStatus,
  } = useQuery<unknown>({
    queryKey: [
      'linked-trader-first-screen',
      validatedActiveAccount?.platform,
      validatedActiveAccount?.traderKey,
    ],
    queryFn: async () => {
      const response = await fetcher<ApiSuccessResponse<unknown>>(selectedServingUrl!)
      return response.data
    },
    enabled: !!selectedServingUrl,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: (failureCount, error) => {
      if ((error as Error & { status?: number }).status === 404) return false
      return failureCount < 2
    },
  })
  const exactSelectedFirstScreenRequest = validatedActiveAccount
    ? ({
        kind: 'linked',
        platform: validatedActiveAccount.platform,
        traderKey: validatedActiveAccount.traderKey,
      } as const)
    : null
  const parsedSelectedServingResponse = exactSelectedFirstScreenRequest
    ? parseExactTraderFirstScreenResponse(selectedServingResponse, exactSelectedFirstScreenRequest)
    : null
  const selectedServingSettledAfterMount =
    selectedServingFetchedAfterMount &&
    selectedServingFetchStatus === 'idle' &&
    !selectedServingFetching
  const selectedServingReady = Boolean(
    validatedActiveAccount &&
    selectedServingSettledAfterMount &&
    !selectedServingError &&
    parsedSelectedServingResponse
  )
  const selectedServingFirstScreen = selectedServingReady
    ? (parsedSelectedServingResponse?.firstScreen ?? null)
    : null
  const selectedServingNotFound = Boolean(
    exactSelectedFirstScreenRequest &&
    selectedServingSettledAfterMount &&
    isExactSourceNotServingError(selectedServingError, exactSelectedFirstScreenRequest)
  )
  const selectedServingData = selectedServingFirstScreen
    ? firstScreenToTraderData(
        selectedServingFirstScreen,
        validatedActiveAccount?.handle || validatedActiveAccount?.traderKey || urlHandle,
        parsedSelectedServingResponse?.is_verified_data ?? false
      )
    : null

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
  const { tabKeys, activeTab, visitedTabs, handleTabChange } = useTraderTabs(visibleClaimedUser)

  // Stable callback for pricing redirect — avoids creating new closure on every render
  // which would defeat React.memo in StatsTab / PortfolioTab.
  const handlePricingRedirect = useCallback(() => router.push('/pricing'), [router])

  // ── P7: Merged trader detail fetch (bundles claim + rank_history) ──
  // Linked membership intentionally uses its own exact, no-store live request.
  //
  // The URL only depends on `data` + `activeAccount` (parsed inline, no lookup),
  // so it doesn't need linkedAccounts. handle-vs-traderKey is resolved separately
  // below for display purposes.

  // SWR for full trader data — switches URL when account tab changes
  // Bundle non-membership extras only for the primary account.
  const effectivePlatform = validatedActiveAccount
    ? validatedActiveAccount.platform
    : !activeAccountRaw
      ? searchParams?.get('platform') || data.source || ''
      : ''
  const effectiveRouteKey = validatedActiveAccount
    ? validatedActiveAccount.traderKey
    : !activeAccountRaw
      ? data.handle || data.source_trader_id
      : ''
  const effectiveTraderKey = validatedActiveAccount
    ? validatedActiveAccount.traderKey
    : !activeAccountRaw
      ? data.source_trader_id
      : ''
  const primaryUsesServerDetail =
    isPrimaryAccount && baseIdentityReady && !override && !legacyPlatformOverride
  const traderApiUrl = (() => {
    if (!isPrimaryAccount && !validatedActiveAccount) return null
    const base = effectivePlatform
      ? `/api/traders/${encodeURIComponent(effectiveRouteKey)}?source=${encodeURIComponent(effectivePlatform)}`
      : `/api/traders/${encodeURIComponent(effectiveRouteKey)}`
    // Only bundle extras for the primary account (not when switching linked accounts)
    if (primaryUsesServerDetail) {
      const separator = base.includes('?') ? '&' : '?'
      return `${base}${separator}include=rank_history`
    }
    return base
  })()
  const shouldFetchLegacyTrader =
    (primaryUsesServerDetail && !isServing) ||
    Boolean(validatedActiveAccount && selectedServingNotFound)
  type TraderDataWithExtras = TraderPageData & {
    claim_status?: ExactTraderClaimData
    rank_history?: {
      history: { date: string; rank: number; arena_score: number }[]
      platform?: string
      trader_key?: string
      period?: string
      _error?: string
    }
  }
  // Server-rendered props can originate from an HTML payload produced before
  // this browser loaded the current client bundle. Treat them exactly like a
  // network response: legacy history is never trusted merely because an old
  // payload claimed it was complete.
  const quarantinedServerTraderData = useMemo(
    () =>
      serverTraderData
        ? (quarantineLegacyPositionHistory(serverTraderData) as TraderDataWithExtras)
        : undefined,
    [serverTraderData]
  )
  const {
    data: traderData,
    error: traderError,
    isLoading: traderLoading,
    isPlaceholderData: traderDataIsPlaceholder,
    isFetchedAfterMount: traderDataFetchedAfterMount,
    fetchStatus: traderFetchStatus,
    isFetching: traderDataFetching,
  } = useQuery<TraderDataWithExtras>({
    queryKey: ['trader-profile', PUBLIC_PROFILE_HISTORY_QUERY_EPOCH, traderApiUrl],
    queryFn: () => traderFetcher<TraderDataWithExtras>(traderApiUrl!),
    // The route's serving account never touches the legacy endpoint. A linked
    // subject may do so only after its exact first-screen probe proves a 404.
    enabled: shouldFetchLegacyTrader && !!traderApiUrl,
    refetchOnWindowFocus: false,
    // Pause auto-refresh when the tab is hidden to save bandwidth/CPU/battery
    refetchInterval: () =>
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? false
        : 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    staleTime: primaryUsesServerDetail ? STALE_STANDARD : 0,
    gcTime: primaryUsesServerDetail ? 5 * 60 * 1000 : 0,
    // Don't retry 404s — trader definitively doesn't exist. Retry transient errors.
    retry: (failureCount, error) => {
      if ((error as Error & { status?: number }).status === 404) return false
      return failureCount < 2
    },
    initialData: primaryUsesServerDetail ? quarantinedServerTraderData : undefined,
    // #30: Skip refetch on mount when serverTraderData is provided (ISR freshness)
    refetchOnMount: primaryUsesServerDetail && serverTraderData ? false : 'always',
  })

  const legacySelectedDetailReady = Boolean(
    validatedActiveAccount &&
    selectedServingNotFound &&
    traderDataFetchedAfterMount &&
    traderFetchStatus === 'idle' &&
    !traderDataFetching &&
    !traderError &&
    !traderDataIsPlaceholder &&
    traderDetailMatchesLinkedAccount(traderData, validatedActiveAccount)
  )
  const selectedDetailReady = selectedServingReady || legacySelectedDetailReady
  const scopedTraderData = legacyPlatformOverride
    ? legacyPlatformOverride
    : primaryUsesServerDetail
      ? traderData
      : legacySelectedDetailReady
        ? traderData
        : undefined
  const suppressAccountContent =
    suppressAccountMetrics || (linkedAccountScope.mode === 'selected' && !selectedDetailReady)
  const accountContentStatus: 'checking' | 'unavailable' =
    (!baseIdentityReady &&
      (accountOverrideFetching ||
        legacyPlatformOverrideFetching ||
        (accountOverrideAllowsLegacy && !legacyPlatformOverrideFetchedAfterMount))) ||
    linkedAccountsLoading ||
    (linkedAccountScope.mode === 'selected' &&
      (selectedServingLoading ||
        selectedServingFetching ||
        (selectedServingNotFound && traderLoading)))
      ? 'checking'
      : 'unavailable'

  // Claim ownership is never authorized from this longer-lived profile query.
  // Every visitor uses the dedicated exact, no-store status boundary below.
  const bundledClaimData = undefined
  const rawBundledRankHistory = primaryUsesServerDetail ? traderData?.rank_history : undefined
  const parsedBundledRankHistory =
    !traderDataIsPlaceholder && rawBundledRankHistory?._error === undefined
      ? parseExactRankHistory(rawBundledRankHistory, data.source, data.source_trader_id)
      : null
  const bundledRankHistory = parsedBundledRankHistory
    ? { history: parsedBundledRankHistory }
    : undefined

  // U3-1c: A 404 from the supplementary /api/traders fetch must NOT blank an
  // already-SSR-rendered page. Reaching this client means the server DID resolve
  // the trader (else generateMetadata would have 404'd before streaming) and
  // shipped identity/scores in `serverData`. The supplementary fetch only ADDS
  // claim/rank_history — a 404 means those extras are unavailable, not
  // that the trader is missing. Warn once so the degradation stays observable.
  useEffect(() => {
    const status = (traderError as (Error & { status?: number }) | null)?.status
    if (
      primaryUsesServerDetail &&
      traderError &&
      status === 404 &&
      (serverData?.source_trader_id || serverData?.handle)
    ) {
      console.warn(
        '[trader] supplementary /api/traders 404 — keeping SSR-rendered data (claim/rank_history unavailable)',
        { handle: serverData?.handle, source: serverData?.source }
      )
    }
  }, [
    primaryUsesServerDetail,
    traderError,
    serverData?.source_trader_id,
    serverData?.handle,
    serverData?.source,
  ])

  // Membership is a live privacy boundary. It is never authorized from the
  // longer-lived trader-profile query or its React Query cache.
  // Reclaim malformed, unsupported serving, and authoritatively unlinked URL
  // selections. The render above has already failed closed, so this cleanup
  // cannot leak a frame or trigger an untrusted detail request.
  useEffect(() => {
    if (linkedAccountScope.shouldResetSelection) handleAccountChange('all')
  }, [handleAccountChange, linkedAccountScope.shouldResetSelection])

  // Any aggregate/unresolved/loading subject has no truthful single-account
  // Stats or Portfolio scope. Return to Overview until exact detail is ready.
  useEffect(() => {
    if (suppressAccountContent && (activeTab === 'stats' || activeTab === 'portfolio')) {
      handleTabChange('overview')
    }
  }, [activeTab, handleTabChange, suppressAccountContent])

  // Every visitor, including anonymous badge viewers, uses the exact no-store
  // probe. A longer-lived profile bundle may never resurrect an unlinked claim.
  const claimSubject =
    isPrimaryAccount && baseIdentityReady
      ? { traderId: data.source_trader_id, source: data.source }
      : validatedActiveAccount
        ? {
            traderId:
              parsedSelectedServingResponse?.subject.traderKey ??
              (legacySelectedDetailReady
                ? (traderData?.profile?.trader_key ?? traderData?.profile?.id)
                : null) ??
              validatedActiveAccount.traderKey,
            source:
              selectedServingFirstScreen?.source ??
              (legacySelectedDetailReady ? traderData?.profile?.source : null) ??
              validatedActiveAccount.platform,
          }
        : null
  const claimUrl = claimSubject
    ? `/api/traders/claim/status?trader_id=${encodeURIComponent(claimSubject.traderId)}&source=${encodeURIComponent(claimSubject.source)}`
    : null
  const {
    data: claimResponse,
    error: claimDataError,
    isFetchedAfterMount: claimDataFetchedAfterMount,
    fetchStatus: claimFetchStatus,
    isFetching: claimIsFetching,
  } = useQuery<unknown>({
    queryKey: ['trader-claim-status', claimSubject?.traderId, claimSubject?.source],
    queryFn: () => fetcher(claimUrl!, { cache: 'no-store' }),
    enabled: !!claimUrl,
    refetchOnWindowFocus: true,
    retry: false,
    // HTTP no-store does not control React Query's memory cache. Always
    // revalidate this authorization probe and do not authorize from data that
    // only predates the current observer mount or whose refresh has failed.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  })
  const freshExactClaim =
    claimDataFetchedAfterMount && claimFetchStatus === 'idle' && !claimIsFetching && !claimDataError
      ? parseExactTraderClaimEnvelope(claimResponse)
      : null

  // Keep public badge data separate from owner authorization/editor data.
  const claimSources = claimSubject
    ? resolveTraderClaimSources({
        traderId: claimSubject.traderId,
        source: claimSubject.source,
        bundledClaim: bundledClaimData,
        bundledIsPlaceholder: traderDataIsPlaceholder,
        exactClaim: freshExactClaim,
        requireExactAuthorization: Boolean(currentUserId),
      })
    : null
  const publicClaimSource = claimSources?.publicClaimSource ?? null
  const authorizationClaimSource = claimSources?.authorizationClaimSource ?? null
  const isVerifiedTrader = !!publicClaimSource?.is_verified
  const { isProfileOwner, isVerifiedClaimOwner } = resolveTraderProfileOwnership({
    currentUserId,
    claimedUserId: visibleClaimedUser?.id,
    isVerifiedClaim: !!authorizationClaimSource?.is_verified,
    claimOwnerId: authorizationClaimSource?.owner_id,
  })
  const isProfilePageOwner = isProfileOwner || isVerifiedClaimOwner

  // Rank history for sparkline (7-day trajectory)
  // P7: Skip separate fetch when bundled data is available from the merged endpoint
  const accountDetailReady = (isPrimaryAccount && baseIdentityReady) || selectedDetailReady
  const rankHistoryPlatform =
    selectedServingFirstScreen?.source ?? override?.firstScreen.source ?? effectivePlatform
  const rankHistoryTraderKey =
    parsedSelectedServingResponse?.subject.traderKey ??
    (legacySelectedDetailReady
      ? (traderData?.profile?.trader_key ?? traderData?.profile?.id)
      : null) ??
    effectiveTraderKey
  const rankHistoryUrl =
    accountDetailReady &&
    !suppressAccountMetrics &&
    !bundledRankHistory &&
    rankHistoryPlatform &&
    rankHistoryTraderKey
      ? `/api/trader/rank-history?platform=${encodeURIComponent(rankHistoryPlatform)}&trader_key=${encodeURIComponent(rankHistoryTraderKey)}&period=90D&days=7`
      : null
  const { data: rankHistoryResponse } = useQuery<{
    history: { date: string; rank: number; arena_score: number }[]
    platform: string
    trader_key: string
    period: string
  }>({
    queryKey: ['trader-rank-history', rankHistoryPlatform, rankHistoryTraderKey],
    queryFn: () => traderFetcher(rankHistoryUrl!),
    enabled: !!rankHistoryUrl,
    refetchOnWindowFocus: false,
    staleTime: STALE_RELAXED,
    retry: 1,
  })
  const exactRankHistory =
    rankHistoryPlatform && rankHistoryTraderKey
      ? parseExactRankHistory(rankHistoryResponse, rankHistoryPlatform, rankHistoryTraderKey)
      : null
  const rankSparklineData =
    suppressAccountMetrics || !accountDetailReady
      ? []
      : ((bundledRankHistory?.history ?? exactRankHistory)?.map((h) => ({
          rank: h.rank,
        })) ?? [])

  // Stable references for derived SWR data — memoize so child components
  // wrapped in React.memo can bail out of re-render when traderData
  // identity changes but the underlying field hasn't.
  const traderProfile = useMemo(
    () => scopedTraderData?.profile ?? null,
    [scopedTraderData?.profile]
  )
  const traderPerformance = useMemo(
    () => scopedTraderData?.performance ?? null,
    [scopedTraderData?.performance]
  )
  // A pre-quarantine client cache can outlive a route deployment. Gate every
  // legacy-history consumer on the explicit evidence state as a second line of
  // defense; absence is never rendered as a flat zero-valued chart or position.
  const legacyHistoryComplete = scopedTraderData?.historyCompleteness?.state === 'complete'
  const traderStats = useMemo(
    () => (legacyHistoryComplete ? (scopedTraderData?.stats ?? null) : null),
    [legacyHistoryComplete, scopedTraderData?.stats]
  )
  const traderPortfolio = useMemo(
    () => (legacyHistoryComplete ? (scopedTraderData?.portfolio ?? []) : []),
    [legacyHistoryComplete, scopedTraderData?.portfolio]
  )
  const traderEquityCurve = useMemo(
    () => (legacyHistoryComplete ? scopedTraderData?.equityCurve : undefined),
    [legacyHistoryComplete, scopedTraderData?.equityCurve]
  )
  const traderAssetBreakdown = useMemo(
    () => (legacyHistoryComplete ? scopedTraderData?.assetBreakdown : undefined),
    [legacyHistoryComplete, scopedTraderData?.assetBreakdown]
  )
  const traderPositionSummary = useMemo(
    () => (legacyHistoryComplete ? (scopedTraderData?.positionSummary ?? null) : null),
    [legacyHistoryComplete, scopedTraderData?.positionSummary]
  )
  const traderSimilar = useMemo(
    () => scopedTraderData?.similarTraders ?? [],
    [scopedTraderData?.similarTraders]
  )
  const unresolvedRequestedAccount =
    activeAccountRaw && !validatedActiveAccount ? activeAccountRaw : null
  const visibleSource = validatedActiveAccount
    ? selectedServingData?.source || traderProfile?.source || validatedActiveAccount.platform
    : unresolvedRequestedAccount?.platform || data.source
  const visibleTraderKey = validatedActiveAccount
    ? parsedSelectedServingResponse?.subject.traderKey ||
      traderProfile?.trader_key ||
      traderProfile?.id ||
      validatedActiveAccount.traderKey
    : unresolvedRequestedAccount?.traderKey || data.source_trader_id
  const visibleHandle = validatedActiveAccount
    ? selectedServingData?.handle ||
      traderProfile?.handle ||
      validatedActiveAccount.handle ||
      validatedActiveAccount.traderKey
    : unresolvedRequestedAccount?.traderKey || traderProfile?.handle || data.handle
  const visibleDisplayName = formatDisplayName(visibleHandle, visibleSource)
  const visibleAvatarUrl = validatedActiveAccount
    ? selectedServingData?.avatar_url || traderProfile?.avatar_url || undefined
    : unresolvedRequestedAccount
      ? undefined
      : traderProfile?.avatar_url || data.avatar_url || undefined
  const exactPerformance = traderPerformance as ExtendedPerformance | null
  const exactPerformanceRecord = traderPerformance as Record<string, unknown> | null
  const visibleData: UnregisteredTraderData = isPrimaryAccount
    ? data
    : (selectedServingData ?? {
        handle: visibleHandle,
        avatar_url: visibleAvatarUrl ?? null,
        source: visibleSource,
        source_trader_id: visibleTraderKey,
        rank: null,
        arena_score: exactPerformance?.arena_score_90d ?? exactPerformance?.arena_score ?? null,
        roi: exactPerformance?.roi_90d ?? null,
        pnl: exactPerformance?.pnl ?? null,
        win_rate: exactPerformance?.win_rate ?? null,
        max_drawdown: exactPerformance?.max_drawdown ?? null,
        sharpe_ratio: (exactPerformanceRecord?.sharpe_ratio as number | null) ?? null,
        sortino_ratio: (exactPerformanceRecord?.sortino_ratio as number | null) ?? null,
        profit_factor: (exactPerformanceRecord?.profit_factor as number | null) ?? null,
        calmar_ratio: (exactPerformanceRecord?.calmar_ratio as number | null) ?? null,
        avg_holding_hours:
          (exactPerformanceRecord?.avg_holding_time_hours as number | null) ?? null,
        profitability_score: exactPerformance?.profitability_score ?? null,
        risk_control_score: exactPerformance?.risk_control_score ?? null,
        execution_score: exactPerformance?.execution_score ?? null,
        is_verified_data: false,
      })
  const visibleIsVerifiedData = isPrimaryAccount
    ? isVerifiedData
    : Boolean(selectedServingReady && parsedSelectedServingResponse?.is_verified_data)
  const headerAccountMetrics = resolveTraderHeaderAccountMetrics(suppressAccountContent, {
    roi90d:
      exactPerformance?.roi_90d ??
      (accountDetailReady && visibleData.roi != null ? visibleData.roi : undefined),
    arenaScore:
      exactPerformance?.arena_score_90d ??
      exactPerformance?.arena_score ??
      (accountDetailReady ? (visibleData.arena_score ?? null) : null),
    scoreConfidence: exactPerformance?.score_confidence ?? null,
    tradesCount: exactPerformance?.trades_count ?? null,
    rank: accountDetailReady ? (visibleData.rank ?? null) : null,
    platform: accountDetailReady ? visibleSource : effectivePlatform || undefined,
    traderKey: accountDetailReady ? visibleTraderKey : undefined,
    tradingStyle:
      (exactPerformanceRecord?.tradingStyle as string) ?? exactPerformance?.trading_style ?? null,
    lastUpdated:
      scopedTraderData?.lastUpdated ??
      scopedTraderData?.trackedSince ??
      (validatedActiveAccount ? selectedServingFirstScreen : servingFirstScreen)?.entries.find(
        (entry) => entry.timeframe === 90
      )?.provenance.asOf,
    isBot: visibleSource === 'web3_bot',
  })

  // P4 three-tab unification (spec §4): every serving source renders the SAME
  // Overview/Stats/Portfolio tabs as legacy (fed via legacy-adapter), instead of
  // the trimmed ServingProfilePanel. Now the DEFAULT for serving — browse-verified
  // across CEX full-surface / board-backfill / onchain (§2.5d). Escape hatch:
  // ?threetab=0 or NEXT_PUBLIC_SERVING_THREE_TAB=0 falls back to the panel (kept
  // for instant rollback until the panel code is retired). The hook is called
  // unconditionally (hooks rule); `enabled` gates every fetch off for legacy.
  const visibleIsServing = validatedActiveAccount
    ? selectedServingReady
    : override
      ? true
      : legacyPlatformOverride
        ? false
        : isServing
  const useThreeTab =
    visibleIsServing &&
    searchParams.get('threetab') !== '0' &&
    process.env.NEXT_PUBLIC_SERVING_THREE_TAB !== '0'
  const servingViewFirstScreen = validatedActiveAccount
    ? selectedServingFirstScreen
    : servingFirstScreen
  const exactFirstScreenCapability = validatedActiveAccount
    ? (parsedSelectedServingResponse?.capability ?? null)
    : override
      ? override.capability
      : legacyPlatformOverride
        ? null
        : baseIdentityReady
          ? serverCapability
          : null
  // The route's capability RPC is intentionally bounded by a 2s cold-start
  // race. Refill a missing matrix for the exact visible serving subject,
  // including legacy-ISR → serving override and linked-account switches.
  const capabilitySource = servingViewFirstScreen?.source ?? visibleData.source
  const { capabilities: clientCapabilities } = useSourceCapabilities(
    visibleIsServing && !exactFirstScreenCapability
  )
  const servingViewCapability =
    exactFirstScreenCapability ?? clientCapabilities?.[capabilitySource] ?? null
  const servingTab = useServingTabData(
    {
      source: visibleData.source,
      exchangeTraderId: visibleData.source_trader_id,
      nickname: servingViewFirstScreen?.nickname ?? visibleData.handle ?? null,
      avatarSrc: servingViewFirstScreen?.avatarSrc ?? null,
      entries: servingViewFirstScreen?.entries,
      scores: validatedActiveAccount || override ? undefined : servingScores,
    },
    servingViewCapability ?? null,
    useThreeTab && !suppressAccountContent
  )
  // The public /core projection is quarantined for every timeframe (see
  // lib/data/serving/core-quarantine.ts and useServingTabData, which uses the
  // static projection without a request), so the tabs show one explicit
  // "under verification" state instead of blank charts.
  const historyUnderVerification = useThreeTab && !suppressAccountContent
  // Only sealed public-cohort values (verified rank + ROI) may be shown here.
  const verificationTf = ({ '7D': 7, '30D': 30 } as Record<string, number>)[selectedPeriod] ?? 90
  const verificationEntry = historyUnderVerification
    ? servingViewFirstScreen?.entries.find((e) => e.timeframe === verificationTf)
    : undefined
  const sealedRank =
    verificationEntry?.rankingVisibility === 'verified' &&
    typeof verificationEntry.rank === 'number' &&
    typeof verificationEntry.headlineRoi === 'number'
      ? verificationEntry.rank
      : null
  const sealedRoi = sealedRank !== null ? (verificationEntry?.headlineRoi ?? null) : null

  // 即看即算: for a web3 wallet with no on-chain data yet, compute it on demand
  // (bounded) instead of waiting for the 12h rotation, then refetch.
  const onchainEnrichmentState = useOnchainEnrichTrigger({
    source: visibleData.source,
    exchangeTraderId: visibleData.source_trader_id,
    extras: servingTab.metaExtras,
    enabled: useThreeTab && !suppressAccountContent,
    loaded: useThreeTab && !suppressAccountContent && !servingTab.loading,
  })

  // Effective tab props: serving-derived under the flag, legacy otherwise.
  const effProfile = useThreeTab ? servingTab.traderProfile : traderProfile
  const effPerformance = useThreeTab ? servingTab.traderPerformance : traderPerformance
  const effStats = useThreeTab ? servingTab.traderStats : traderStats
  const effPortfolio = useThreeTab ? servingTab.traderPortfolio : traderPortfolio
  const effPositionHistory = useThreeTab
    ? servingTab.traderPositionHistory
    : EMPTY_LEGACY_POSITION_HISTORY
  const effHistoryCompleteness = useThreeTab
    ? servingTab.historyCompleteness
    : LEGACY_HISTORY_COMPLETENESS_UNKNOWN
  const effEquityCurve = useThreeTab ? servingTab.traderEquityCurve : traderEquityCurve
  const effAssetBreakdown = useThreeTab ? servingTab.traderAssetBreakdown : traderAssetBreakdown
  // U2-12: serving sources have no similarTraders in traderData (the /core path
  // omits them) → OverviewTab's `traderSimilar.length > 0` guard hid the module.
  // Under three-tab (serving default) use the server-computed list; legacy keeps
  // its React-Query-derived traderSimilar untouched.
  const effSimilar = useThreeTab
    ? validatedActiveAccount || override
      ? EMPTY_SIMILAR_TRADERS
      : (serverSimilarTraders ?? EMPTY_SIMILAR_TRADERS)
    : traderSimilar

  // Loading state: only when SWR is loading AND no server fallback
  const isInitialLoading = isPrimaryAccount && traderLoading && !serverTraderData
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
  // case means only the claim/rank_history extras are unavailable — the
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
              href="/"
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
  const showStaleBanner = isPrimaryAccount && !!traderError && (!!traderData || hasServerIdentity)

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
          items={[{ label: t('leaderboardBreadcrumb'), href: '/' }, { label: visibleDisplayName }]}
        />

        <TraderStaleBanner show={showStaleBanner} t={t} />
        <TraderPlatformDeadBanner
          show={isPrimaryAccount && !!data.is_platform_dead}
          source={visibleSource}
          t={t}
        />

        {/* Sticky mini header for mobile */}
        <div className={`trader-sticky-mini-header${showMiniHeader ? ' visible' : ''}`}>
          <div
            className="mini-avatar"
            style={{
              background: visibleAvatarUrl
                ? 'var(--color-bg-tertiary)'
                : getAvatarGradient(visibleTraderKey),
              display: 'grid',
              placeItems: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            {visibleAvatarUrl ? (
              <Image
                src={avatarSrc(visibleAvatarUrl)}
                alt={visibleDisplayName}
                width={28}
                height={28}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                unoptimized
              />
            ) : (
              visibleDisplayName.charAt(0).toUpperCase()
            )}
          </div>
          <span className="mini-name">{visibleDisplayName}</span>
          {headerAccountMetrics.roi90d != null && (
            <span
              className="mini-roi"
              style={{
                color:
                  headerAccountMetrics.roi90d >= 0
                    ? tokens.colors.accent.success
                    : tokens.colors.accent.error,
              }}
            >
              {formatROI(headerAccountMetrics.roi90d)}
            </span>
          )}
        </div>

        {/* Trader Header */}
        <div ref={headerRef}>
          <TraderHeader
            key={`${linkedAccountScope.mode}:${visibleSource}:${visibleTraderKey}`}
            handle={visibleHandle}
            displayName={visibleDisplayName}
            traderId={traderProfile?.id || visibleTraderKey}
            registeredUserId={visibleClaimedUser?.id}
            avatarUrl={visibleAvatarUrl}
            isRegistered={!!visibleClaimedUser}
            isOwnProfile={isProfilePageOwner}
            followers={traderProfile?.followers ?? undefined}
            source={visibleSource}
            roi90d={headerAccountMetrics.roi90d}
            arenaScore={headerAccountMetrics.arenaScore}
            scoreConfidence={headerAccountMetrics.scoreConfidence}
            tradesCount={headerAccountMetrics.tradesCount}
            rank={headerAccountMetrics.rank}
            currentUserId={currentUserId}
            isVerifiedTrader={isVerifiedTrader}
            isBot={headerAccountMetrics.isBot}
            lastUpdated={headerAccountMetrics.lastUpdated}
            claimedBio={
              (validatedActiveAccount || override ? null : visibleClaimedUser?.bio) ||
              ((traderProfile as Record<string, unknown> | null)?.bio as string | undefined)
            }
            claimedAvatarUrl={
              validatedActiveAccount || override ? undefined : visibleClaimedUser?.avatar_url
            }
            linkedAccountCount={hasMultipleAccounts ? linkedAccounts.length : undefined}
            linkedPlatforms={
              hasMultipleAccounts ? linkedAccounts.map((a) => a.platform) : undefined
            }
            platform={headerAccountMetrics.platform}
            traderKey={headerAccountMetrics.traderKey}
            tradingStyle={headerAccountMetrics.tradingStyle}
            isAggregateView={suppressAccountContent}
          />
        </div>

        {/* Rank sparkline — 7-day rank trajectory.
            CLS 修复(Lighthouse 2026-07-10, trader CLS 0.144 元凶):此条此前等
            客户端 rank-history fetch 到达才渲染,出现瞬间把下方 ExchangeLinksBar/
            tabs/profile-grid 整体下推 ~34px(两次 grid shift 合计 0.098)。
            服务端已知 rank(data.rank)时首帧即预留固定高度,数据到了往里填——
            无 rank 的交易员照旧不渲染,不留空洞。 */}
        {!suppressAccountMetrics &&
          (rankSparklineData.length >= 2 || headerAccountMetrics.rank != null) && (
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

        <LinkedAccountStatus isLoading={linkedAccountsLoading} error={linkedAccountsError} />

        {/* Multi-account tabs (only shown after exact live membership succeeds) */}
        {hasMultipleAccounts && (
          <LinkedAccountTabs
            accounts={linkedAccounts}
            activeAccount={activeAccount}
            onAccountChange={handleAccountChange}
          />
        )}

        {/* Exchange links — copy-trade / DEX view per exchange, below header */}
        {baseIdentityReady && !suppressAccountContent && (
          <ExchangeLinksBar
            primary={{
              platform: data.source,
              traderKey: data.source_trader_id,
              handle: data.handle,
            }}
            linkedAccounts={
              hasMultipleAccounts
                ? linkedAccounts.map((a) => ({
                    platform: a.platform,
                    traderKey: a.traderKey,
                    handle: a.handle,
                  }))
                : undefined
            }
            activeAccount={validatedActiveAccount ? activeAccount : 'all'}
            isOwnProfile={isProfilePageOwner}
          />
        )}

        {/* Serving mode (spec §2.4): the body below the header reads from
            arena.* via /core + /records — legacy tabs are not rendered. */}
        {visibleIsServing && !useThreeTab && !suppressAccountContent && servingViewFirstScreen && (
          <ServingProfilePanel
            firstScreen={servingViewFirstScreen}
            capability={servingViewCapability ?? null}
          />
        )}

        {/* Tabs — legacy sources always; serving sources under the P4 flag */}
        {(!visibleIsServing || useThreeTab || suppressAccountContent) && (
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
            extraTabs={visibleClaimedUser ? ['posts'] : undefined}
            hideTabs={suppressAccountContent ? ['stats', 'portfolio'] : undefined}
          />
        )}
        <ProUpsellModal
          open={proUpsellOpen}
          onClose={() => setProUpsellOpen(false)}
          featureKey="upgradeProStatsDesc"
        />

        {/* Tab Content — dims while loading account switch */}
        {(!visibleIsServing || useThreeTab || suppressAccountContent) && (
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
                onIndexChange={(i) => {
                  const nextTab = tabKeys[i]
                  if (suppressAccountContent && (nextTab === 'stats' || nextTab === 'portfolio')) {
                    return
                  }
                  handleTabChange(nextTab)
                }}
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
                  {!suppressAccountContent && (
                    <Box style={{ marginBottom: tokens.spacing[3] }}>
                      <DataProvenanceBadge
                        verified={visibleIsVerifiedData}
                        // Tracked chip doubles as the verify-upgrade entry (A1
                        // adoption pull) — same URL shape as ClaimTraderButton.
                        claimHref={
                          visibleIsVerifiedData
                            ? undefined
                            : buildTraderClaimReturnPath({
                                traderId: visibleData.source_trader_id,
                                source: visibleData.source,
                                handle: visibleData.handle,
                              })
                        }
                      />
                    </Box>
                  )}
                  {/* §2.3 lead-meta strip — serving only; NULL-collapses to
                      null when no meta fields resolve (legacy renders nothing). */}
                  {useThreeTab && !suppressAccountContent && (
                    <Box style={{ marginBottom: tokens.spacing[3] }}>
                      <TraderMetaStrip
                        extras={servingTab.metaExtras}
                        currency={servingTab.currency}
                      />
                      {/* M1: risk rating / style tags / last-liquidation chips +
                          MEXC ability radar — surfaced on the default path. Both
                          NULL-collapse when the source lacks the extras. */}
                      <SignalChips source={visibleData.source} extras={servingTab.metaExtras} />
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
                        source={visibleData.source}
                        exchangeTraderId={visibleData.source_trader_id}
                        enabled={useThreeTab && Boolean(servingViewCapability?.surfaces?.orders)}
                      />
                    </Box>
                  )}
                  <OverviewTab
                    data={visibleData}
                    traderProfile={effProfile}
                    traderPerformance={effPerformance}
                    traderEquityCurve={
                      effEquityCurve as
                        | import('@/app/(app)/u/[handle]/components/types').EquityCurveData
                        | undefined
                    }
                    traderSimilar={effSimilar}
                    positionSummary={
                      traderPositionSummary as
                        | {
                            avgLeverage: number | null
                            longPositions: number | null
                            shortPositions: number | null
                          }
                        | null
                        | undefined
                    }
                    selectedPeriod={selectedPeriod}
                    hasMultipleAccounts={
                      hasMultipleAccounts || linkedAccountScope.mode === 'aggregate'
                    }
                    activeAccount={activeAccount}
                    aggregatedData={aggregatedData}
                    linkedAccounts={linkedAccounts}
                    suppressAccountContent={suppressAccountContent}
                    accountContentStatus={accountContentStatus}
                    currentUserId={currentUserId}
                    isVerifiedClaimOwner={isVerifiedClaimOwner}
                    isVerifiedTrader={isVerifiedTrader}
                    verifiedTraderProfile={authorizationClaimSource?.profile ?? null}
                    claimedUser={visibleClaimedUser}
                    historyUnderVerification={historyUnderVerification}
                    sealedRankingPeriod={`${verificationTf}D`}
                    sealedRank={sealedRank}
                    sealedRoi={sealedRoi}
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
                  {!suppressAccountContent && visitedTabs.has('stats') ? (
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
                          source={visibleData.source}
                          exchangeTraderId={visibleData.source_trader_id}
                          capability={servingViewCapability ?? null}
                          tf={90}
                          exchangeName={servingViewCapability?.exchangeName}
                          excludeKinds={['positions', 'position_history']}
                        />
                      )}
                      <StatsTab
                        visited
                        stats={effStats}
                        traderHandle={effProfile?.handle || visibleData.handle}
                        assetBreakdown={effAssetBreakdown}
                        equityCurve={effEquityCurve}
                        positionHistory={effPositionHistory}
                        historyCompleteness={effHistoryCompleteness}
                        isPro={isPro}
                        onUnlock={handlePricingRedirect}
                        historyUnderVerification={historyUnderVerification}
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
                  {!suppressAccountContent && visitedTabs.has('portfolio') ? (
                    <PortfolioTab
                      visited
                      portfolio={effPortfolio}
                      positionHistory={effPositionHistory}
                      historyCompleteness={effHistoryCompleteness}
                      source={visibleData.source}
                      isPro={isPro}
                      onUnlock={handlePricingRedirect}
                      historyUnderVerification={historyUnderVerification}
                    />
                  ) : null}
                </Box>

                {/* Posts Tab (only for claimed traders) — lazy mount on first visit */}
                {visibleClaimedUser && (
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
                          authorHandle={visibleClaimedUser.handle}
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
          className="trader-data-disclaimer"
          size="xs"
          color="tertiary"
          style={{ textAlign: 'center', marginTop: tokens.spacing[6] }}
        >
          {t('dataDisclaimer')}
        </Text>
      </Box>
    </Box>
  )
}
