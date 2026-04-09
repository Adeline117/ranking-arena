/**
 * Hero Stats 数据层
 *
 * 获取首页展示的统计数据（交易所数量、交易员数量）
 * 使用 Redis 缓存，TTL 1 小时（数据变化不频繁）
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'

// 默认值 - 当缓存和数据库都不可用时的回退
// Must be close to actual 90D ranked count (~17K) to avoid inflated display.
const DEFAULT_STATS = {
  exchangeCount: 27,
  traderCount: 17000,
}

const CACHE_KEY = 'hero-stats:v1'
const FALLBACK_MARKER_KEY = 'hero-stats:v1:fallback-marker'
// Success path ('cold' tier): 1h Redis TTL on CACHE_KEY (stats only change on cron runs).
// Fallback path: a SEPARATE marker key with 60s TTL, NOT overwriting CACHE_KEY.
// Previously we wrote defaults to CACHE_KEY, which meant a single RPC failure
// would evict the last known-good real value for 5 min. Now the real cache
// stays intact; the marker just tracks "tried recently" for stampede control.

export interface HeroStats {
  exchangeCount: number
  traderCount: number
  isDefault?: boolean
}

/**
 * 获取 Hero 统计数据
 *
 * 优先级：Redis 缓存 → 数据库查询 → 默认值
 * 缓存 TTL: 1 小时
 */
export async function getHeroStats(): Promise<HeroStats> {
  try {
    // 1. Try cache (real data only — defaults are never written to CACHE_KEY)
    const { data: cached } = await tieredGet<HeroStats>(CACHE_KEY, 'cold')
    if (cached && !cached.isDefault) {
      return cached
    }

    // 2. Stampede control: if a previous request recently failed, skip the
    // RPC and return defaults. Without this, every concurrent SSR would
    // race the slow RPC. The marker auto-expires in ~60s.
    const { data: marker } = await tieredGet<{ failedAt: number }>(FALLBACK_MARKER_KEY, 'hot')
    if (marker) {
      // A prior request failed recently. Prefer STALE real data (if any)
      // over defaults so the UI keeps the last known-good number.
      if (cached) return cached
      return { ...DEFAULT_STATS, isDefault: true }
    }

    // 3. Query DB (3s timeout — SSR must never hang)
    const supabase = getSupabaseAdmin()
    const rpcPromise = supabase.rpc('get_hero_stats').single()
    const timeoutPromise = new Promise<{ data: null; error: { code: string; message: string } }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: { code: 'TIMEOUT', message: 'SSR hero stats timeout' } }), 3000)
    )
    const { data, error } = await Promise.race([rpcPromise, timeoutPromise])

    if (error) {
      if (error.code === 'TIMEOUT' || error.code === 'PGRST202') {
        logger.warn(`[getHeroStats] RPC unavailable (${error.code}), using defaults`)
      } else {
        logger.warn(`[getHeroStats] RPC failed (${error.code}), using defaults`)
      }
      // Write ONLY the marker — leave CACHE_KEY untouched so the last
      // known-good value is preserved for the next request.
      void tieredSet(FALLBACK_MARKER_KEY, { failedAt: Date.now() }, 'hot', ['hero-stats', 'fallback']).catch(() => {})
      // Prefer stale real data if available, otherwise defaults.
      if (cached) return cached
      return { ...DEFAULT_STATS, isDefault: true }
    }

    const rpcData = data as { exchange_count?: number; trader_count?: number } | null
    const stats: HeroStats = {
      exchangeCount: rpcData?.exchange_count || DEFAULT_STATS.exchangeCount,
      traderCount: rpcData?.trader_count || DEFAULT_STATS.traderCount,
    }

    // 4. Cache success result
    await tieredSet(CACHE_KEY, stats, 'cold', ['hero-stats'])

    return stats
  } catch (error) {
    logger.error('[getHeroStats] Unexpected error', error)
    return { ...DEFAULT_STATS, isDefault: true }
  }
}
