/**
 * Trader 粉丝数管理 - 简化版
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export async function getTraderArenaFollowersCount(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<number> {
  if (!traderId.trim() || !source.trim()) return 0

  try {
    // KEEP 'exact' — this is one exchange account, bounded by the composite
    // (trader_id, source) index. Never merge a reused raw id across sources.
    const { count } = await supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('trader_id', traderId)
      .eq('source', source)

    return count || 0
  } catch (err) {
    logger.debug(
      '[trader-followers] single count lookup failed:',
      err instanceof Error ? err.message : String(err)
    )
    return 0
  }
}
