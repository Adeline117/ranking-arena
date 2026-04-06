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

const logger = createLogger('ranking-store')

const REDIS_KEY_PREFIX = 'ranking:live'
const TTL_SECONDS = 2 * 60 * 60 // 2 hours

// Write buffer configuration
const BUFFER_FLUSH_MS = 1000  // flush every 1s
const BUFFER_MAX_SIZE = 100   // or when buffer hits 100 items per key
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
    flushBuffer().catch(err => logger.warn('[ranking-store] flushBuffer failed:', err))
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

/**
 * Sync sorted set from leaderboard_ranks table.
 * Called after compute-leaderboard finishes to ensure full consistency.
 * Returns the number of traders synced.
 */
export async function syncSortedSetFromLeaderboard(
  supabase: SupabaseClient,
  period: string
): Promise<number> {
  const redis = await getSharedRedis()
  if (!redis) return 0

  try {
    const key = redisKey(period)

    // Fetch all ranked traders with scores
    let allTraders: Array<{ source: string; source_trader_id: string; arena_score: number }> = []
    let offset = 0
    const PAGE_SIZE = 1000

    while (true) {
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, arena_score')
        .eq('season_id', period.toUpperCase())
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .order('arena_score', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)

      if (error || !data?.length) break
      allTraders = allTraders.concat(data as Array<{ source: string; source_trader_id: string; arena_score: number }>)
      if (data.length < PAGE_SIZE) break
      offset += PAGE_SIZE
    }

    if (allTraders.length === 0) {
      logger.warn(`[ranking-store] No traders found for ${period}, skipping sync`)
      return 0
    }

    // Delete old key and rebuild — pipeline for atomicity
    const pipeline = redis.pipeline()
    pipeline.del(key)

    // Batch ZADD in chunks of 500 to avoid oversized pipeline commands
    const CHUNK_SIZE = 500
    for (let i = 0; i < allTraders.length; i += CHUNK_SIZE) {
      const chunk = allTraders.slice(i, i + CHUNK_SIZE)
      for (const t of chunk) {
        pipeline.zadd(key, { score: t.arena_score, member: memberKey(t.source, t.source_trader_id) })
      }
    }

    pipeline.expire(key, TTL_SECONDS)
    await pipeline.exec()

    logger.info(`[ranking-store] Synced ${allTraders.length} traders to ${key}`)
    return allTraders.length
  } catch (error) {
    logger.error('[ranking-store] syncSortedSetFromLeaderboard failed:', error)
    return 0
  }
}
