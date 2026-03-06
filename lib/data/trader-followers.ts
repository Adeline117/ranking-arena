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
    // Use individual count queries (head: true) to avoid fetching all rows
    // Batch in parallel with concurrency limit
    const BATCH_SIZE = 10
    for (let i = 0; i < traderIds.length; i += BATCH_SIZE) {
      const batch = traderIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map(async (traderId) => {
          const { count } = await supabase
            .from('trader_follows')
            .select('*', { count: 'exact', head: true })
            .eq('trader_id', traderId)
          return { traderId, count: count || 0 }
        })
      )
      for (const { traderId, count } of results) {
        resultMap.set(traderId, count)
      }
    }
  } catch {
    // Keep all as 0 on error
  }

  return resultMap
}
