/**
 * Quarantined hot-trader scoring surface.
 *
 * The previous momentum/follower/frequency inputs came from legacy daily rows
 * without cohort or publication provenance. Preserve the type/API boundary but
 * return no recommendations until sealed daily cohorts exist.
 */

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface HotTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  followers: number | null
  trades_count: number | null
  hot_score: number
  signals: HotSignals
}

export interface HotSignals {
  roiMomentum: number
  followerGrowth: number
  tradingFrequency: number
  recency: number
}

export async function computeHotTraders(limit = 50): Promise<HotTrader[]> {
  void limit
  return []
}
