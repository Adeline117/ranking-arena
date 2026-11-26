/**
 * Hero Stats 数据层
 *
 * 获取首页展示的统计数据（交易所数量、交易员数量）
 * 使用 Redis 缓存，TTL 1 小时（数据变化不频繁）
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'
import { ssrRace } from '@/lib/constants/timeouts'

/**
 * Client-side ceiling for the get_hero_stats RPC.
 *
 * The function's own statement_timeout is 5 seconds (migration
 * 20261124225312; it was 2). The view evaluates the row policy once per row,
 * and on the full board (about 8,400 rows after the ROI + PnL rule) the count
 * takes roughly 2 seconds warm and more on a cold cache. The generic 3 second
 * SSR budget used here before would have aborted the call ahead of the
 * database limit and left the hero and the percentile badge with no number.
 * Half a second above the database limit, so a slow call is ended by the
 * database (and reported as such) rather than by this abort.
 *
 * Paid at most once an hour per cache key (the result is cached), and at most
 * once a minute while the RPC is failing (the fallback marker).
 */
export const HERO_STATS_RPC_TIMEOUT_MS = 5_500

// Returned when the cache and the database are both unavailable. These are
// placeholders, not facts: every result built from them carries
// `isDefault: true`, and consumers must render no number at all (see
// `buildProductFactsSnapshot` / CrossExchangePercentileBadge). They are zero
// on purpose so that a consumer that forgets the flag cannot display an
// invented figure.
const DEFAULT_STATS = {
  sourceBoardCount: 0,
  traderCount: 0,
}

// v3: the RPC now reports live ranking source boards instead of guessing an
// exchange family from the first source-name segment. A fresh key prevents the
// old 18-family value from surviving its one-hour TTL.
const CACHE_KEY = 'hero-stats:v3'
const FALLBACK_MARKER_KEY = 'hero-stats:v3:fallback-marker'
// Success path ('cold' tier): 1h Redis TTL on CACHE_KEY (stats only change on cron runs).
// Fallback path: a SEPARATE marker key with 60s TTL, NOT overwriting CACHE_KEY.
// Previously we wrote defaults to CACHE_KEY, which meant a single RPC failure
// would evict the last known-good real value for 5 min. Now the real cache
// stays intact; the marker just tracks "tried recently" for stampede control.

function finiteCount(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

export interface HeroStats {
  sourceBoardCount: number
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
  // 2026-07-11:build 期短路（镜像 getInitialTraders:103）。此前缺此 guard 是
  // 首页 ISR 失效真因 —— build-time 静态生成时下面的 tieredGet(Upstash REST)+
  // Supabase RPC 都带 AbortSignal → 不可缓存 fetch → Next 判 `/` 为动态,
  // revalidate=300 被忽略,每 PV 都 SSR+MISS(宣传第一落点零边缘缓存)。build 时
  // 返回 defaults 让 `/` 静态预渲染;运行时 ISR 后台再生会跑真实 fetch。
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return { ...DEFAULT_STATS, isDefault: true }
  }
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

    // 3. Query DB (bounded — SSR must never hang; see HERO_STATS_RPC_TIMEOUT_MS)
    // ssrRace cancels the PostgREST HTTP request on timeout (vs Promise.race
    // which abandons the query in the background, wasting a connection).
    const supabase = getSupabaseAdmin()
    const result = await ssrRace(
      (signal) => supabase.rpc('get_hero_stats').abortSignal(signal).single(),
      HERO_STATS_RPC_TIMEOUT_MS,
      { data: null, error: { code: 'TIMEOUT', message: 'SSR hero stats timeout' } as const }
    )
    const { data, error } = result ?? {
      data: null,
      error: { code: 'TIMEOUT', message: 'SSR hero stats timeout' } as const,
    }

    if (error) {
      if (error.code === 'TIMEOUT' || error.code === 'PGRST202') {
        logger.warn(`[getHeroStats] RPC unavailable (${error.code}), using defaults`)
      } else {
        logger.warn(`[getHeroStats] RPC failed (${error.code}), using defaults`)
      }
      // Write ONLY the marker — leave CACHE_KEY untouched so the last
      // known-good value is preserved for the next request.

      void tieredSet(FALLBACK_MARKER_KEY, { failedAt: Date.now() }, 'hot', [
        'hero-stats',
        'fallback',
      ]).catch(() => {})
      // Prefer stale real data if available, otherwise defaults.
      if (cached) return cached
      return { ...DEFAULT_STATS, isDefault: true }
    }

    const rpcData = data as { exchange_count?: unknown; trader_count?: unknown } | null
    // The SQL output name remains exchange_count for backward compatibility;
    // migration 20260717130000 defines its value as live source-board count.
    // A real 0 (empty public board) is a fact and must be shown as 0 — never
    // swapped for the fallback. Only a missing/non-numeric field is "unknown".
    const sourceBoardCount = finiteCount(rpcData?.exchange_count)
    const traderCount = finiteCount(rpcData?.trader_count)
    if (sourceBoardCount === null || traderCount === null) {
      logger.warn('[getHeroStats] RPC returned a malformed payload, using defaults')
      if (cached) return cached
      // Defaults are never written to CACHE_KEY (see header comment).
      return { ...DEFAULT_STATS, isDefault: true }
    }
    const stats: HeroStats = { sourceBoardCount, traderCount }

    // 4. Cache success result
    await tieredSet(CACHE_KEY, stats, 'cold', ['hero-stats'])

    return stats
  } catch (error) {
    logger.error('[getHeroStats] Unexpected error', error)
    return { ...DEFAULT_STATS, isDefault: true }
  }
}
