/**
 * Similar traders lookup — finds traders with comparable performance.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedTrader } from './types'
import { mapLeaderboardRow } from './mappers'

export async function fetchSimilarTraders(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null,
): Promise<UnifiedTrader[]> {
  try {
    let data: Record<string, unknown>[] | null = null

    if (arenaScore != null) {
      const scoreRange = Math.max(arenaScore * 0.25, 10)
      const result = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate, max_drawdown, followers, rank, season_id, source_type, trader_type, computed_at')
        .eq('source', platform)
        .eq('season_id', '90D')
        .neq('source_trader_id', traderKey)
        .not('arena_score', 'is', null)
        .gte('arena_score', arenaScore - scoreRange)
        .lte('arena_score', arenaScore + scoreRange)
        .order('arena_score', { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    } else if (roi != null) {
      const roiRange = Math.max(Math.abs(roi) * 0.3, 20)
      const result = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate, max_drawdown, followers, rank, season_id, source_type, trader_type, computed_at')
        .eq('source', platform)
        .eq('season_id', '90D')
        .neq('source_trader_id', traderKey)
        .gte('roi', roi - roiRange)
        .lte('roi', roi + roiRange)
        .order('roi', { ascending: false })
        .limit(10)
      data = result.data as Record<string, unknown>[] | null
    }

    if (!data || data.length === 0) return []

    // Dedupe and map
    const seen = new Set<string>()
    return data
      .filter(row => {
        const id = String(row.source_trader_id || '')
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map(row => mapLeaderboardRow(row))
  } catch {
    return []
  }
}
