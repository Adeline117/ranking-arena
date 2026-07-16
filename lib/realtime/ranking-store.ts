/**
 * Redis Sorted Set for near-real-time rankings
 *
 * Uses Upstash Redis ZADD/ZREVRANK/ZREVRANGE to maintain a live ranking
 * that updates incrementally as new trader data arrives from batch-fetch-traders,
 * and fully syncs after compute-leaderboard runs.
 *
 * Key schema: ranking:live:{period} (e.g. ranking:live:90D)
 * Member format: {platform}:{traderKey}
 * Score: arena_score (float)
 * TTL: 2 hours (auto-expire if cron stops running)
 */

import { getSharedRedis } from '@/lib/cache/redis-client'
import { createLogger } from '@/lib/utils/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const logger = createLogger('ranking-store')

const REDIS_KEY_PREFIX = 'ranking:live'
const TTL_SECONDS = 2 * 60 * 60 // 2 hours

// Write buffer configuration
const BUFFER_FLUSH_MS = 1000 // flush every 1s
const BUFFER_MAX_SIZE = 100 // or when buffer hits 100 items per key
const BUFFER_MAX_TOTAL_ITEMS = 50000 // hard cap: prevent OOM during Redis outage

function redisKey(period: string): string {
  return `${REDIS_KEY_PREFIX}:${period.toUpperCase()}`
}

function memberKey(platform: string, traderKey: string): string {
  return `${platform}:${traderKey}`
}

function parseMemberKey(member: string): { platform: string; traderKey: string } {
  const idx = member.indexOf(':')
  return {
    platform: member.slice(0, idx),
    traderKey: member.slice(idx + 1),
  }
}

// ============================================
// Write Buffer — batches individual ZADD calls into pipelined writes
// ============================================

const writeBuffer: Map<string, Array<{ member: string; score: number }>> = new Map()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushBuffer().catch((err) => logger.warn('[ranking-store] flushBuffer failed:', err))
  }, BUFFER_FLUSH_MS)
}

/**
 * Flush all buffered writes to Redis via pipeline (single round-trip per key).
 * Exported for testing and explicit flush (e.g., at end of cron job).
 */
export async function flushBuffer(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  if (writeBuffer.size === 0) return

  const redis = await getSharedRedis()
  if (!redis) {
    const discarded = [...writeBuffer.values()].reduce((sum, items) => sum + items.length, 0)
    if (discarded > 0) {
      logger.warn(`[ranking-store] Redis unavailable, discarding ${discarded} buffered writes`)
    }
    writeBuffer.clear()
    return
  }

  // Snapshot and clear buffer atomically to avoid losing items during async flush
  const snapshot = new Map(writeBuffer)
  writeBuffer.clear()

  for (const [key, items] of snapshot) {
    if (items.length === 0) continue

    try {
      const pipeline = redis.pipeline()
      for (const { member, score } of items) {
        pipeline.zadd(key, { score, member })
      }
      pipeline.expire(key, TTL_SECONDS)
      await pipeline.exec()
    } catch (error) {
      logger.warn(`[ranking-store] flushBuffer failed for ${key} (${items.length} items):`, error)
    }
  }
}

/**
 * Update a trader's score in the sorted set.
 * Writes are buffered and flushed every 1s or when 100 items accumulate per key,
 * reducing Redis round-trips by ~100x during batch cron runs.
 */
export async function updateTraderScore(
  period: string,
  platform: string,
  traderKey: string,
  arenaScore: number
): Promise<void> {
  const key = redisKey(period)
  const member = memberKey(platform, traderKey)

  // Hard cap: if buffer exceeds max total items, force flush to prevent OOM
  const totalBuffered = [...writeBuffer.values()].reduce((sum, items) => sum + items.length, 0)
  if (totalBuffered >= BUFFER_MAX_TOTAL_ITEMS) {
    logger.warn(`[ranking-store] Buffer hit hard cap (${totalBuffered} items), forcing flush`)
    await flushBuffer()
  }

  if (!writeBuffer.has(key)) writeBuffer.set(key, [])
  writeBuffer.get(key)!.push({ member, score: arenaScore })

  if (writeBuffer.get(key)!.length >= BUFFER_MAX_SIZE) {
    await flushBuffer()
  } else {
    scheduleFlush()
  }
}

/**
 * Get real-time rank for a trader (0-indexed from ZREVRANK, convert to 1-indexed).
 * Returns null if the trader is not in the sorted set or Redis is unavailable.
 */
export async function getTraderRank(
  period: string,
  platform: string,
  traderKey: string
): Promise<number | null> {
  const redis = await getSharedRedis()
  if (!redis) return null

  try {
    const key = redisKey(period)
    const member = memberKey(platform, traderKey)
    const rank = await redis.zrevrank(key, member)
    return rank != null ? rank + 1 : null // Convert 0-indexed to 1-indexed
  } catch (error) {
    logger.warn('[ranking-store] getTraderRank failed:', error)
    return null
  }
}

/**
 * Get top N traders from sorted set (highest score first).
 * Uses ZRANGE with REV option for descending order with scores.
 */
export async function getTopTraders(
  period: string,
  limit: number,
  offset: number = 0
): Promise<Array<{ platform: string; traderKey: string; score: number; rank: number }>> {
  const redis = await getSharedRedis()
  if (!redis) return []

  try {
    const key = redisKey(period)
    // ZRANGE key start stop REV WITHSCORES — returns highest scores first
    const results = await redis.zrange<string[]>(key, offset, offset + limit - 1, {
      rev: true,
      withScores: true,
    })

    // Results come as [member, score, member, score, ...]
    const traders: Array<{ platform: string; traderKey: string; score: number; rank: number }> = []
    for (let i = 0; i < results.length; i += 2) {
      const member = results[i]
      const score = Number(results[i + 1])
      const { platform, traderKey } = parseMemberKey(member)
      traders.push({
        platform,
        traderKey,
        score,
        rank: offset + traders.length + 1, // 1-indexed
      })
    }

    return traders
  } catch (error) {
    logger.warn('[ranking-store] getTopTraders failed:', error)
    return []
  }
}

/**
 * Get the total number of members in the sorted set for a period.
 */
export async function getSortedSetSize(period: string): Promise<number> {
  const redis = await getSharedRedis()
  if (!redis) return 0

  try {
    return await redis.zcard(redisKey(period))
  } catch (error) {
    logger.warn('[ranking-store] getSortedSetSize failed:', error)
    return 0
  }
}

// Redis Hash key for trader display data (used by Redis-first leaderboard reads)
const DETAIL_HASH_PREFIX = 'ranking:detail'
const DETAIL_HASH_TTL = 2 * 60 * 60 // 2 hours (same as sorted set)

function detailHashKey(period: string): string {
  return `${DETAIL_HASH_PREFIX}:${period.toUpperCase()}`
}

/** Fields fetched from leaderboard_ranks for Redis-first reads */
const SYNC_SELECT_FIELDS = [
  'source',
  'source_trader_id',
  'arena_score',
  'roi',
  'pnl',
  'win_rate',
  'max_drawdown',
  'trades_count',
  'followers',
  'copiers',
  'handle',
  'avatar_url',
  'rank',
  'computed_at',
  'source_type',
  'profitability_score',
  'risk_control_score',
  'execution_score',
  'score_completeness',
  'trading_style',
  'avg_holding_hours',
  'sharpe_ratio',
  'sortino_ratio',
  'profit_factor',
  'calmar_ratio',
  'trader_type',
  'is_outlier',
  'season_id',
].join(', ')

/**
 * Sync sorted set from leaderboard_ranks table.
 * Called after compute-leaderboard finishes to ensure full consistency.
 * Also stores trader display details in a Redis Hash for Redis-first reads.
 * Returns the number of traders synced.
 */
export async function syncSortedSetFromLeaderboard(
  supabase: SupabaseClient<Database>,
  period: string
): Promise<number> {
  const redis = await getSharedRedis()
  if (!redis) return 0

  try {
    const key = redisKey(period)
    const hashKey = detailHashKey(period)

    // Fetch all ranked traders with display fields
    let allTraders: Array<Record<string, unknown>> = []
    let offset = 0
    const PAGE_SIZE = 1000

    while (true) {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select(SYNC_SELECT_FIELDS)
        .eq('season_id', period.toUpperCase())
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('arena_score', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

      if (error || !data?.length) break
      allTraders = allTraders.concat(data as unknown as Array<Record<string, unknown>>)
      if (data.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }

    if (allTraders.length === 0) {
      logger.warn(`[ranking-store] No traders found for ${period}, skipping sync`)
      return 0
    }

    // Pipeline 1: Sorted set (ZADD) for ranking
    const pipeline = redis.pipeline()
    pipeline.del(key)

    const CHUNK_SIZE = 500
    for (let i = 0; i < allTraders.length; i += CHUNK_SIZE) {
      const chunk = allTraders.slice(i, i + CHUNK_SIZE)
      for (const t of chunk) {
        const source = String(t.source)
        const traderId = String(t.source_trader_id)
        pipeline.zadd(key, { score: Number(t.arena_score), member: memberKey(source, traderId) })
      }
    }
    pipeline.expire(key, TTL_SECONDS)
    await pipeline.exec()

    // Pipeline 2: Hash map for trader details (top 200 only to limit memory)
    // Beyond top 200, fallback to DB is acceptable (low traffic)
    const TOP_N_CACHED = 200
    const topTraders = allTraders.slice(0, TOP_N_CACHED)
    const hashPipeline = redis.pipeline()
    hashPipeline.del(hashKey)
    for (const t of topTraders) {
      const member = memberKey(String(t.source), String(t.source_trader_id))
      hashPipeline.hset(hashKey, { [member]: JSON.stringify(t) })
    }
    hashPipeline.expire(hashKey, DETAIL_HASH_TTL)
    await hashPipeline.exec()

    logger.info(
      `[ranking-store] Synced ${allTraders.length} traders to ${key}, ${topTraders.length} details to ${hashKey}`
    )
    return allTraders.length
  } catch (error) {
    logger.error('[ranking-store] syncSortedSetFromLeaderboard failed:', error)
    return 0
  }
}

/**
 * Get top traders with full display details from Redis (sorted set + hash).
 * Returns UnifiedTrader-compatible records for direct rendering.
 * Falls back to empty array if Redis unavailable (caller should query DB).
 */
export async function getTopTradersWithDetails(
  period: string,
  limit: number,
  offset: number = 0
): Promise<Array<Record<string, unknown>>> {
  const redis = await getSharedRedis()
  if (!redis) return []

  try {
    const key = redisKey(period)
    const hashKey = detailHashKey(period)

    // Get member keys from sorted set
    const results = await redis.zrange<string[]>(key, offset, offset + limit - 1, {
      rev: true,
      withScores: true,
    })

    if (!results || results.length === 0) return []

    // Extract member keys (every other element is a score)
    const memberKeys: string[] = []
    for (let i = 0; i < results.length; i += 2) {
      memberKeys.push(results[i])
    }

    // Batch fetch details from hash
    const detailPipeline = redis.pipeline()
    for (const mk of memberKeys) {
      detailPipeline.hget(hashKey, mk)
    }
    const detailResults = await detailPipeline.exec()

    const traders: Array<Record<string, unknown>> = []
    for (let i = 0; i < memberKeys.length; i++) {
      const raw = detailResults[i] as string | null
      if (raw) {
        try {
          traders.push(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          // Corrupted entry, skip
        }
      }
    }

    return traders
  } catch (error) {
    logger.warn('[ranking-store] getTopTradersWithDetails failed:', error)
    return []
  }
}
