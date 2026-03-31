/**
 * Similar traders lookup — finds traders with comparable performance.
 * Queries leaderboard_ranks which uses v1 column names (source, source_trader_id, season_id).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedTrader } from './types'
import { mapLeaderboardRow } from './mappers'
import { LR } from '@/lib/types/schema-mapping'

export async function fetchSimilarTraders(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null,
): Promise<UnifiedTrader[]> {
  try {
    let data: Record<string, unknown>[] | null = null

    // leaderboard_ranks column mapping: source → platform, source_trader_id → traderKey, season_id → period
    if (arenaScore != null) {
      const scoreRange = Math.max(arenaScore * 0.25, 10)
      const result = await supabase
        .from('leaderboard_ranks')
        .select(`${LR.source}, ${LR.source_trader_id}, ${LR.handle}, ${LR.avatar_url}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown, followers, ${LR.rank}, ${LR.season_id}, source_type, trader_type, computed_at`)
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .neq(LR.source_trader_id, traderKey)
        .not(LR.arena_score, 'is', null)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .gte(LR.arena_score, arenaScore - scoreRange)
        .lte(LR.arena_score, arenaScore + scoreRange)
        .order(LR.arena_score, { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    } else if (roi != null) {
      const roiRange = Math.max(Math.abs(roi) * 0.3, 20)
      const result = await supabase
        .from('leaderboard_ranks')
        .select(`${LR.source}, ${LR.source_trader_id}, ${LR.handle}, ${LR.avatar_url}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown, followers, ${LR.rank}, ${LR.season_id}, source_type, trader_type, computed_at`)
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .neq(LR.source_trader_id, traderKey)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .gte(LR.roi, roi - roiRange)
        .lte(LR.roi, roi + roiRange)
        .order(LR.roi, { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    }

    if (!data || data.length === 0) return []

    // Dedupe and map
    const seen = new Set<string>()
    return data
      .filter(row => {
        const id = String(row[LR.source_trader_id] || '')
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map(row => mapLeaderboardRow(row))
  } catch {
    return []
  }
}
