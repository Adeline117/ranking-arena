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
  /** Per-TF sub-scores + trading style from leaderboard_ranks (server-fetched,
   *  2026-07-09): the /core path carries raw stats only, so ScoreBreakdownSection
   *  and the header style tag rendered empty in serving mode. */
  scores?: import('../TraderProfileClient').ServingScoreRow[]
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
    // Arena Score breakdown + trading style (2026-07-09): thread the
    // leaderboard_ranks per-season sub-scores into the legacy performance
    // shape ScoreBreakdownSection/TraderHeader read. Mapping mirrors
    // lib/data/trader/mappers.ts (returnScore=profitability_score,
    // pnlScore=risk_control_score; drawdown/stability have no V3 columns).
    for (const row of scores ?? []) {
      const sfx = row.season_id === '7D' ? '_7d' : row.season_id === '30D' ? '_30d' : ''
      const p = traderPerformance as Record<string, unknown>
      if (row.arena_score != null) p[`arena_score${sfx || '_90d'}`] = Number(row.arena_score)
      if (row.arena_score_v3 != null)
        p[`arena_score_v3${sfx || '_90d'}`] = Number(row.arena_score_v3)
      if (row.profitability_score != null) p[`return_score${sfx}`] = Number(row.profitability_score)
      if (row.risk_control_score != null) p[`pnl_score${sfx}`] = Number(row.risk_control_score)
      if (row.season_id === '90D') {
        if (row.arena_score != null) p.arena_score = Number(row.arena_score)
        if (row.profitability_score != null) p.profitability_score = Number(row.profitability_score)
        if (row.risk_control_score != null) p.risk_control_score = Number(row.risk_control_score)
        if (row.execution_score != null) p.execution_score = Number(row.execution_score)
        if (row.trading_style != null) p.trading_style = row.trading_style
        if (row.style_confidence != null) p.style_confidence = Number(row.style_confidence)
        if (row.avg_holding_hours != null) p.avg_holding_hours = Number(row.avg_holding_hours)
        if (row.score_completeness != null) p.score_confidence = row.score_completeness
      }
    }
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
    scores,
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
