/**
 * Trader 粉丝数管理 - 简化版
 */

import { SupabaseClient } from '@supabase/supabase-js'

export async function getTraderArenaFollowersCount(
  supabase: SupabaseClient,
  traderId: string
): Promise<number> {
  try {
    const { count } = await supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId)

    return count || 0
  } catch {
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
    // Single query: fetch all follow rows for these traders, then count in JS
    const { data } = await supabase
      .from('trader_follows')
      .select('trader_id')
      .in('trader_id', traderIds)

    if (data) {
      for (const row of data) {
        resultMap.set(row.trader_id, (resultMap.get(row.trader_id) || 0) + 1)
      }
    }
  } catch {
    // Keep all as 0 on error
  }

  return resultMap
}
