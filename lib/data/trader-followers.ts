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

  try {
    const { data } = await supabase
      .from('trader_follows')
      .select('trader_id')
      .in('trader_id', traderIds)

    // 统计每个 trader 的粉丝数
    if (data) {
      data.forEach((row: { trader_id: string }) => {
        const currentCount = resultMap.get(row.trader_id) || 0
        resultMap.set(row.trader_id, currentCount + 1)
      })
    }

    // 设置没有粉丝的 trader 为 0
    traderIds.forEach(id => {
      if (!resultMap.has(id)) {
        resultMap.set(id, 0)
      }
    })
  } catch {
    traderIds.forEach(id => resultMap.set(id, 0))
  }

  return resultMap
}
