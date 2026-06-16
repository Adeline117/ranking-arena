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
import type { TraderFirstScreen, SourceCapability } from '@/lib/data/serving/types'
import type {
  PortfolioItem,
  PositionHistoryItem,
  TraderPerformance,
  TraderProfile,
  TraderStats,
} from '@/lib/data/trader-types'

export interface ServingTabData {
  traderProfile: TraderProfile
  traderPerformance: TraderPerformance
  traderEquityCurve: EquityCurveByTf
  traderAssetBreakdown: AssetBreakdownByTf
  traderStats: TraderStats
  traderPortfolio: PortfolioItem[]
  traderPositionHistory: PositionHistoryItem[]
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
    c7.isLoading,
    c30.isLoading,
    c90.isLoading,
  ])
}
