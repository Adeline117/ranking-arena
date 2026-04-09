/**
 * Trader 粉丝数管理 - 简化版
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export async function getTraderArenaFollowersCount(
  supabase: SupabaseClient,
  traderId: string
): Promise<number> {
  try {
    // KEEP 'exact' — scoped to a single trader via eq(trader_id), which
    // hits the (trader_id) index and returns a tiny row set. The exact
    // number is shown as the "Arena Followers" badge on the trader card.
    const { count } = await supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId)

    return count || 0
  } catch (err) {
    logger.debug('[trader-followers] single count lookup failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

export async function getTradersArenaFollowersCount(
  supabase: SupabaseClient,
  traderIds: string[]
): Promise<Map<string, number>> {
  const resultMap = new Map<string, number>()

  if (!traderIds || traderIds.length === 0) {
    return resultMap
  }

  // Initialize all to 0
  traderIds.forEach(id => resultMap.set(id, 0))

  try {
    // Use RPC for GROUP BY count (returns 1 row per trader instead of 1 row per follow)
    const { data, error } = await supabase
      .rpc('count_trader_followers', { trader_ids: traderIds })

    if (!error && data) {
      for (const row of data as { trader_id: string; cnt: number }[]) {
        resultMap.set(row.trader_id, row.cnt)
      }
    } else {
      // Fallback: fetch individual rows and count in JS
      const { data: fallbackData } = await supabase
        .from('trader_follows')
        .select('trader_id')
        .in('trader_id', traderIds)
        .limit(10000)

      if (fallbackData) {
        for (const row of fallbackData) {
          resultMap.set(row.trader_id, (resultMap.get(row.trader_id) || 0) + 1)
        }
      }
    }
  } catch (err) {
    logger.debug('[trader-followers] batch count lookup failed:', err instanceof Error ? err.message : String(err))
  }

  return resultMap
}
