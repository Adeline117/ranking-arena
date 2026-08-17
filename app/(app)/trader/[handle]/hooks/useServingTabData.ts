'use client'

/**
 * P4: serving → legacy-tab data hook. Fetches the serving data the unified
 * Overview/Stats/Portfolio tabs need (3 core modules — one per TF — + the
 * positions / position-history record surfaces) and maps it onto the legacy
 * tab prop shapes via lib/data/serving/legacy-adapter. So a serving source
 * renders the SAME rich three-tab frontend as legacy, with zero on-demand
 * fetching duplicated. Missing data NULL-collapses (tabs tolerate undefined).
 *
 * The 3 /core fetches are React-Query-cached and dedupe with ServingProfilePanel
 * (same query keys), so flipping between the two layouts costs no extra network.
 */

import { useMemo } from 'react'
import { useTraderCore } from '@/lib/hooks/useTraderCore'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'
import {
  servingToTraderProfile,
  servingStatsToPerformance,
  servingSeriesToEquityCurve,
  servingToAssetBreakdown,
  servingToStats,
  applyServingScoresToPerformance,
  positionsToPortfolio,
  historyToPositionHistory,
  type EquityCurveByTf,
  type AssetBreakdownByTf,
} from '@/lib/data/serving/legacy-adapter'
import { promoteExtrasMetrics, EXTRAS_PROMOTABLE_KEYS } from '@/lib/constants/metric-registry'
import type {
  HistoryCompleteness,
  TraderFirstScreen,
  SourceCapability,
  ServingCurrency,
} from '@/lib/data/serving/types'
import type { PortfolioItem, TraderProfile, TraderStats } from '@/lib/data/trader-types'
import type { PositionHistoryEntry } from '@/app/(app)/u/[handle]/components/types'
import type { ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'
import {
  readGmxMaxCapitalRoiModuleDisclosure,
  readGmxRealizedNetModuleDisclosure,
} from '@/lib/data/serving/pnl-contract'

export type ServingCorePeriod = '7D' | '30D' | '90D'

/** Status remains scoped to its exact timeframe. A warm 7D module cannot make
 * a first-load 90D failure look like merely stale retained data. */
export interface ServingCorePeriodState {
  hasModule: boolean
  isLoading: boolean
  isPendingUpstream: boolean
  isDegraded: boolean
  isRefreshing: boolean
  refetch: () => Promise<unknown>
}

export interface ServingTabData {
  traderProfile: TraderProfile
  traderPerformance: ExtendedPerformance
  traderEquityCurve: EquityCurveByTf
  traderAssetBreakdown: AssetBreakdownByTf
  traderStats: TraderStats
  traderPortfolio: PortfolioItem[]
  traderPositionHistory: PositionHistoryEntry[]
  /** Evidence verdict for the exact position-history response. */
  historyCompleteness: HistoryCompleteness | null
  /** 90d core extras + currency for the §2.3 lead-meta strip (TraderMetaStrip):
   *  last-trade / copier-cap / margin-balance etc. NULL-collapses when absent. */
  metaExtras: Record<string, unknown>
  /** Exact unit of the PnL fact in every available core window. A missing
   * module has no implied dollar denomination, so it remains null. */
  currencyByPeriod: Record<ServingCorePeriod, ServingCurrency | null>
  currency: ServingCurrency
  /** 90d registry-driven superset metric grid (sharpe/sortino/mdd/risk ratios,
   *  incl. DEX Tier-0 derived). NULL-collapses; same data ServingProfilePanel's
   *  MetricGrid uses, so the default three-tab can render it too (M1/M2 unify). */
  gridStats: Record<string, number | string | null>
  gridCapabilityMetrics: string[]
  /** At least one authoritative core module has arrived for this trader. */
  hasCoreModules: boolean
  /** Exact arrival state for each Overview period. Keeps a faster 7D response
   *  from briefly replacing a truthful 90D first-screen snapshot with dashes. */
  coreModuleAvailability: Record<ServingCorePeriod, boolean>
  /** Per-window collection state for the period currently on screen. */
  coreByPeriod: Record<ServingCorePeriod, ServingCorePeriodState>
  /** At least one timeframe is still collecting a server-side refresh. */
  isCorePendingUpstream: boolean
  /** At least one failed window still has retained, truthful values. */
  isCoreStale: boolean
  /** At least one window failed before it produced truthful values. */
  isCoreUnavailable: boolean
  /** A user-initiated retry is refreshing one or more failed core modules. */
  isCoreRefreshing: boolean
  /**
   * No truthful core module exists yet while either the initial request or
   * server-side collection is in progress. Consumers may render a skeleton
   * only for this state; retained modules and terminal failures stay visible.
   */
  isColdCoreLoading: boolean
  /** Retry only timeframe modules whose bounded refresh failed. */
  refetchDegradedCore: () => Promise<unknown>
  loading: boolean
}

/** Minimal identity the hook needs (subset of TraderFirstScreen) — lets the
 *  caller invoke it unconditionally (hooks rule) for legacy sources too, with
 *  `enabled=false` gating every fetch. */
export interface ServingTabInput {
  source: string
  exchangeTraderId: string
  nickname: string | null
  avatarSrc: string | null
  entries?: TraderFirstScreen['entries']
  /** Per-TF sub-scores + trading style from leaderboard_ranks (server-fetched,
   *  2026-07-09): the /core path carries raw stats only, so ScoreBreakdownSection
   *  and the header style tag rendered empty in serving mode. */
  scores?: import('../TraderProfileClient').ServingScoreRow[]
}

/**
 * An explicit `absent` capability is an authority verdict, not a hint. Keep
 * the default three-tab surface aligned with ServingProfilePanel: it may
 * optimistically fetch while the capability matrix is unknown, but it must
 * neither enqueue Tier-C work nor retain a cached module once the source says
 * that exact timeframe is unavailable.
 */
function mayRequestCoreTimeframe(
  capability: SourceCapability | null,
  timeframe: 7 | 30 | 90
): boolean {
  return capability?.timeframes?.[String(timeframe) as '7' | '30' | '90'] !== 'absent'
}

export function useServingTabData(
  input: ServingTabInput,
  capability: SourceCapability | null,
  enabled: boolean
): ServingTabData {
  const { source, exchangeTraderId } = input

  const core7Enabled = enabled && mayRequestCoreTimeframe(capability, 7)
  const core30Enabled = enabled && mayRequestCoreTimeframe(capability, 30)
  const core90Enabled = enabled && mayRequestCoreTimeframe(capability, 90)
  const c7 = useTraderCore({ source, exchangeTraderId, tf: 7, enabled: core7Enabled })
  const c30 = useTraderCore({ source, exchangeTraderId, tf: 30, enabled: core30Enabled })
  const c90 = useTraderCore({ source, exchangeTraderId, tf: 90, enabled: core90Enabled })

  const positions = useTraderRecords({
    source,
    exchangeTraderId,
    kind: 'positions',
    tf: 90,
    enabled: enabled && Boolean(capability?.surfaces?.positions),
  })
  const posHistory = useTraderRecords({
    source,
    exchangeTraderId,
    kind: 'position_history',
    tf: 90,
    enabled: enabled && Boolean(capability?.surfaces?.position_history),
  })

  // React Query intentionally retains cached data when a query becomes
  // disabled. Do not let an earlier unknown-capability response survive an
  // authoritative `absent` verdict in the default three-tab adapter.
  const m7 = core7Enabled ? c7.modules : null
  const m30 = core30Enabled ? c30.modules : null
  const m90 = core90Enabled ? c90.modules : null
  const posRows = positions.rows
  const histRows = posHistory.rows
  const historyCompleteness = posHistory.completeness
  const enabledCoreHooks = [
    core7Enabled ? c7 : null,
    core30Enabled ? c30 : null,
    core90Enabled ? c90 : null,
  ].filter((core): core is typeof c7 => core !== null)
  const coreByPeriod = useMemo<Record<ServingCorePeriod, ServingCorePeriodState>>(
    () => ({
      '7D': {
        hasModule: Boolean(m7),
        isLoading: core7Enabled && c7.isLoading,
        isPendingUpstream: core7Enabled && c7.isPendingUpstream,
        isDegraded: core7Enabled && c7.isDegraded,
        isRefreshing: core7Enabled && c7.isRefreshing,
        refetch: core7Enabled ? c7.refetch : () => Promise.resolve(),
      },
      '30D': {
        hasModule: Boolean(m30),
        isLoading: core30Enabled && c30.isLoading,
        isPendingUpstream: core30Enabled && c30.isPendingUpstream,
        isDegraded: core30Enabled && c30.isDegraded,
        isRefreshing: core30Enabled && c30.isRefreshing,
        refetch: core30Enabled ? c30.refetch : () => Promise.resolve(),
      },
      '90D': {
        hasModule: Boolean(m90),
        isLoading: core90Enabled && c90.isLoading,
        isPendingUpstream: core90Enabled && c90.isPendingUpstream,
        isDegraded: core90Enabled && c90.isDegraded,
        isRefreshing: core90Enabled && c90.isRefreshing,
        refetch: core90Enabled ? c90.refetch : () => Promise.resolve(),
      },
    }),
    [
      m7,
      m30,
      m90,
      core7Enabled,
      core30Enabled,
      core90Enabled,
      c7.isLoading,
      c7.isPendingUpstream,
      c7.isDegraded,
      c7.isRefreshing,
      c7.refetch,
      c30.isLoading,
      c30.isPendingUpstream,
      c30.isDegraded,
      c30.isRefreshing,
      c30.refetch,
      c90.isLoading,
      c90.isPendingUpstream,
      c90.isDegraded,
      c90.isRefreshing,
      c90.refetch,
    ]
  )
  const coreModuleAvailability = useMemo(
    () => ({
      '7D': coreByPeriod['7D'].hasModule,
      '30D': coreByPeriod['30D'].hasModule,
      '90D': coreByPeriod['90D'].hasModule,
    }),
    [coreByPeriod]
  )
  const currencyByPeriod = useMemo<Record<ServingCorePeriod, ServingCurrency | null>>(
    () => ({
      '7D': m7?.currency ?? null,
      '30D': m30?.currency ?? null,
      '90D': m90?.currency ?? null,
    }),
    [m7?.currency, m30?.currency, m90?.currency]
  )
  // This is used only by cross-window supporting components. Individual PnL
  // cards receive currencyByPeriod so a 30D fact never inherits a 90D unit.
  const currency = m90?.currency ?? m30?.currency ?? m7?.currency ?? capability?.currency ?? 'USD'
  const hasCoreModules = Object.values(coreModuleAvailability).some(Boolean)
  const isCoreLoading = enabledCoreHooks.some((core) => core.isLoading)
  const isCorePendingUpstream = enabledCoreHooks.some((core) => core.isPendingUpstream)
  const isCoreStale = Object.values(coreByPeriod).some((core) => core.isDegraded && core.hasModule)
  const isCoreUnavailable = Object.values(coreByPeriod).some(
    (core) => core.isDegraded && !core.hasModule
  )
  const degradedCoreHooks = enabledCoreHooks.filter((core) => core.isDegraded)
  const isCoreRefreshing = degradedCoreHooks.some((core) => core.isRefreshing)
  // The adapter deliberately returns empty, truthy legacy shapes while no
  // modules have arrived. Expose the cold boundary explicitly so the default
  // three-tab view does not mistake a live request for a trader with no data.
  // A retained module stays rendered during refresh, while degraded / disabled
  // states keep their distinct unavailable and capability disclosures.
  const isColdCoreLoading =
    enabledCoreHooks.length > 0 &&
    !hasCoreModules &&
    !isCoreUnavailable &&
    // React Query does not issue the /core request while server-rendering a
    // client component. Treat that exact no-module server boundary as cold too,
    // otherwise SSR would mistake its deliberate empty adapter shape for data.
    (isCoreLoading || isCorePendingUpstream || typeof window === 'undefined')

  const { nickname, avatarSrc, entries, scores } = input

  return useMemo(() => {
    // M2-2e: extras fallback-merge across TFs. 90d wins; keys captured only on
    // shorter TFs (some sources emit per-TF extras) fill in WITHOUT clobbering —
    // otherwise those fields never display (the grid/card/strip read one blob).
    const mergedExtras: Record<string, unknown> = {
      ...(m7?.extras ?? {}),
      ...(m30?.extras ?? {}),
      ...(m90?.extras ?? {}),
    }
    // M2-2e extended (2026-07-03 display audit): same cross-TF fill for TYPED
    // stat columns. Risk metrics (mdd/sharpe/win_positions) are often computed
    // only on shorter TFs, so a 90d-primary grid dashed them even though the
    // trader HAS them at 30d/7d (audit saw MDD/Sharpe "--" in the grid but
    // present in the Stats section + drawdown chart). 90d wins; a null 90d
    // column borrows the first non-null shorter-TF value — mirrors mergedExtras.
    const mergedGridStats: Record<string, number | string | null> = { ...(m90?.stats ?? {}) }
    for (const src of [m30?.stats, m7?.stats]) {
      if (!src) continue
      for (const [k, v] of Object.entries(src)) {
        if (
          (mergedGridStats[k] === null || mergedGridStats[k] === undefined) &&
          v !== null &&
          v !== undefined
        ) {
          mergedGridStats[k] = v
        }
      }
    }
    const best = entries?.find((e) => e.timeframe === 90) ?? entries?.[0]
    const copierExtra = best?.extras?.copier_count ?? best?.extras?.copiers

    const traderPerformance = servingStatsToPerformance({
      tf7: m7?.stats ?? null,
      tf30: m30?.stats ?? null,
      tf90: m90?.stats ?? null,
      // sortino/calmar live in extras (not typed columns) — the Overview
      // MetricBadgesGrid dashed them without this (audit 2026-07-03).
      extras7: m7?.extras ?? null,
      extras30: m30?.extras ?? null,
      extras90: m90?.extras ?? null,
    })
    const pnlDisclosures: NonNullable<ExtendedPerformance['pnlDisclosures']> = {}
    const disclosure7 = readGmxRealizedNetModuleDisclosure(source, 7, m7)
    const disclosure30 = readGmxRealizedNetModuleDisclosure(source, 30, m30)
    const disclosure90 = readGmxRealizedNetModuleDisclosure(source, 90, m90)
    if (disclosure7) pnlDisclosures['7D'] = disclosure7
    if (disclosure30) pnlDisclosures['30D'] = disclosure30
    if (disclosure90) pnlDisclosures['90D'] = disclosure90
    if (Object.keys(pnlDisclosures).length > 0) {
      traderPerformance.pnlDisclosures = pnlDisclosures
    }
    const roiDisclosures: NonNullable<ExtendedPerformance['roiDisclosures']> = {}
    const roiDisclosure7 = readGmxMaxCapitalRoiModuleDisclosure(source, 7, m7)
    const roiDisclosure30 = readGmxMaxCapitalRoiModuleDisclosure(source, 30, m30)
    const roiDisclosure90 = readGmxMaxCapitalRoiModuleDisclosure(source, 90, m90)
    if (roiDisclosure7) roiDisclosures['7D'] = roiDisclosure7
    if (roiDisclosure30) roiDisclosures['30D'] = roiDisclosure30
    if (roiDisclosure90) roiDisclosures['90D'] = roiDisclosure90
    if (Object.keys(roiDisclosures).length > 0) {
      traderPerformance.roiDisclosures = roiDisclosures
    }
    // Keep score and confidence provenance aligned to the exact serving timeframe.
    applyServingScoresToPerformance(traderPerformance, scores)
    const traderEquityCurve = servingSeriesToEquityCurve({
      tf7: m7?.series ?? null,
      tf30: m30?.series ?? null,
      tf90: m90?.series ?? null,
    })

    // U2-2: tiny-principal web3/onchain traders can report a headline ROI that
    // hits the ingest clamp (±10000%), which then contradicts the same-screen
    // equity curve (head shows >10000% while the curve ends at e.g. +62%). When a
    // headline roi sits at the clamp sentinel, prefer the curve's TERMINAL roi
    // (the exact series the chart draws) so the two agree. Serving
    // leaderboard_ranks carries no web3 roi at the clamp, so rankings + share
    // cards are unaffected — this only reconciles the detail head card.
    const ROI_CLAMP = 10000
    const reconcileClampedRoi = (
      roi: number | undefined,
      period: '7D' | '30D' | '90D'
    ): number | undefined => {
      if (typeof roi !== 'number' || Math.abs(roi) < ROI_CLAMP) return roi
      const pts = traderEquityCurve[period]
      const last = pts && pts.length ? pts[pts.length - 1] : null
      const terminal = last && typeof last.roi === 'number' ? last.roi : null
      return terminal != null && Math.abs(terminal) < ROI_CLAMP ? terminal : roi
    }
    traderPerformance.roi_7d = reconcileClampedRoi(traderPerformance.roi_7d, '7D')
    traderPerformance.roi_30d = reconcileClampedRoi(traderPerformance.roi_30d, '30D')
    traderPerformance.roi_90d = reconcileClampedRoi(traderPerformance.roi_90d, '90D')

    return {
      traderProfile: servingToTraderProfile({
        exchangeTraderId,
        nickname,
        avatarMirrorUrl: avatarSrc,
        source,
        copierCount: typeof copierExtra === 'number' ? copierExtra : null,
      }),
      traderPerformance,
      traderEquityCurve,
      traderAssetBreakdown: servingToAssetBreakdown({
        tf7: m7?.extras ?? null,
        tf30: m30?.extras ?? null,
        tf90: m90?.extras ?? null,
      }),
      traderStats: servingToStats(m90?.stats ?? null, m90?.extras ?? null),
      traderPortfolio: positionsToPortfolio(posRows ?? []),
      traderPositionHistory: historyToPositionHistory(histRows ?? []),
      historyCompleteness,
      metaExtras: mergedExtras,
      currencyByPeriod,
      currency,
      gridStats: promoteExtrasMetrics(mergedGridStats, mergedExtras),
      gridCapabilityMetrics: [
        ...(capability?.metrics ?? Object.keys(m90?.stats ?? {})),
        // Extras-sourced metrics (sortino, volatility…) aren't in the capability
        // RPC's trader_stats column scan — allow them when present.
        ...EXTRAS_PROMOTABLE_KEYS,
      ],
      hasCoreModules,
      coreModuleAvailability,
      coreByPeriod,
      isCorePendingUpstream,
      isCoreStale,
      isCoreUnavailable,
      isCoreRefreshing,
      isColdCoreLoading,
      refetchDegradedCore: () => Promise.all(degradedCoreHooks.map((core) => core.refetch())),
      loading: isCoreLoading,
    }
  }, [
    exchangeTraderId,
    source,
    nickname,
    avatarSrc,
    entries,
    scores,
    m7,
    m30,
    m90,
    posRows,
    histRows,
    historyCompleteness,
    capability,
    currencyByPeriod,
    currency,
    hasCoreModules,
    coreModuleAvailability,
    coreByPeriod,
    isCorePendingUpstream,
    isCoreStale,
    isCoreUnavailable,
    isCoreRefreshing,
    isColdCoreLoading,
    isCoreLoading,
    degradedCoreHooks,
  ])
}
