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
  positionsToPortfolio,
  historyToPositionHistory,
  type EquityCurveByTf,
  type AssetBreakdownByTf,
} from '@/lib/data/serving/legacy-adapter'
import { promoteExtrasMetrics, EXTRAS_PROMOTABLE_KEYS } from '@/lib/constants/metric-registry'
import type { TraderFirstScreen, SourceCapability, ServingCurrency } from '@/lib/data/serving/types'
import type { PortfolioItem, TraderProfile, TraderStats } from '@/lib/data/trader-types'
import type { PositionHistoryEntry } from '@/app/(app)/u/[handle]/components/types'
import type { ExtendedPerformance } from '@/app/components/trader/OverviewPerformanceCard'

export interface ServingTabData {
  traderProfile: TraderProfile
  traderPerformance: ExtendedPerformance
  traderEquityCurve: EquityCurveByTf
  traderAssetBreakdown: AssetBreakdownByTf
  traderStats: TraderStats
  traderPortfolio: PortfolioItem[]
  traderPositionHistory: PositionHistoryEntry[]
  /** 90d core extras + currency for the §2.3 lead-meta strip (TraderMetaStrip):
   *  last-trade / copier-cap / margin-balance etc. NULL-collapses when absent. */
  metaExtras: Record<string, unknown>
  currency: ServingCurrency
  /** 90d registry-driven superset metric grid (sharpe/sortino/mdd/risk ratios,
   *  incl. DEX Tier-0 derived). NULL-collapses; same data ServingProfilePanel's
   *  MetricGrid uses, so the default three-tab can render it too (M1/M2 unify). */
  gridStats: Record<string, number | string | null>
  gridCapabilityMetrics: string[]
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
}

export function useServingTabData(
  input: ServingTabInput,
  capability: SourceCapability | null,
  enabled: boolean
): ServingTabData {
  const { source, exchangeTraderId } = input

  const c7 = useTraderCore({ source, exchangeTraderId, tf: 7, enabled })
  const c30 = useTraderCore({ source, exchangeTraderId, tf: 30, enabled })
  const c90 = useTraderCore({ source, exchangeTraderId, tf: 90, enabled })

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

  const m7 = c7.modules
  const m30 = c30.modules
  const m90 = c90.modules
  const posRows = positions.rows
  const histRows = posHistory.rows

  const { nickname, avatarSrc, entries } = input

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
    return {
      traderProfile: servingToTraderProfile({
        exchangeTraderId,
        nickname,
        avatarMirrorUrl: avatarSrc,
        source,
        copierCount: typeof copierExtra === 'number' ? copierExtra : null,
      }),
      traderPerformance: servingStatsToPerformance({
        tf7: m7?.stats ?? null,
        tf30: m30?.stats ?? null,
        tf90: m90?.stats ?? null,
      }),
      traderEquityCurve: servingSeriesToEquityCurve({
        tf7: m7?.series ?? null,
        tf30: m30?.series ?? null,
        tf90: m90?.series ?? null,
      }),
      traderAssetBreakdown: servingToAssetBreakdown({
        tf7: m7?.extras ?? null,
        tf30: m30?.extras ?? null,
        tf90: m90?.extras ?? null,
      }),
      traderStats: servingToStats(m90?.stats ?? null, m90?.extras ?? null),
      traderPortfolio: positionsToPortfolio(posRows ?? []),
      traderPositionHistory: historyToPositionHistory(histRows ?? []),
      metaExtras: mergedExtras,
      currency: m90?.currency ?? 'USD',
      gridStats: promoteExtrasMetrics(mergedGridStats, mergedExtras),
      gridCapabilityMetrics: [
        ...(capability?.metrics ?? Object.keys(m90?.stats ?? {})),
        // Extras-sourced metrics (sortino, volatility…) aren't in the capability
        // RPC's trader_stats column scan — allow them when present.
        ...EXTRAS_PROMOTABLE_KEYS,
      ],
      loading: c7.isLoading || c30.isLoading || c90.isLoading,
    }
  }, [
    exchangeTraderId,
    source,
    nickname,
    avatarSrc,
    entries,
    m7,
    m30,
    m90,
    posRows,
    histRows,
    capability,
    c7.isLoading,
    c30.isLoading,
    c90.isLoading,
  ])
}
