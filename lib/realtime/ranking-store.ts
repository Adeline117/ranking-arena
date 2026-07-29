/**
 * Redis Sorted Set for published rankings
 *
 * Uses Upstash Redis ZADD/ZREVRANK/ZREVRANGE as a read cache. The cache may
 * only be rebuilt from one complete, stable, sealed leaderboard generation;
 * raw incremental observations are never public ranking authority.
 *
 * Key schema: {publication-epoch}:ranking:live:{period}
 * Member format: {platform}:{traderKey}
 * Score: arena_score (float)
 * TTL: 2 hours (auto-expire if cron stops running)
 */

import { getSharedRedis } from '@/lib/cache/redis-client'
import { createLogger } from '@/lib/utils/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

const logger = createLogger('ranking-store')

const REDIS_KEY_PREFIX = 'ranking:sealed-v1'
const TTL_SECONDS = 2 * 60 * 60 // 2 hours
const SYNC_RANKING_SOURCES = Object.freeze(
  filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
)

function redisKey(period: string): string {
  return publicRankingCacheKey(`${REDIS_KEY_PREFIX}:${period.toUpperCase()}`)
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

/**
 * @deprecated Incremental ranking writes are intentionally disabled. Retained
 * temporarily so older jobs can call it safely during the cutover.
 */
export async function flushBuffer(): Promise<void> {
  return
}

/**
 * @deprecated Unsealed incremental scores cannot enter the public ranking
 * cache. A complete sealed generation is the only allowed writer.
 */
export async function updateTraderScore(
  _period: string,
  platform: string,
  _traderKey: string,
  _arenaScore: number
): Promise<void> {
  if (!isPublicRankingSourceAllowed(platform)) return
  // Incremental scores have no publication proof and therefore cannot enter
  // the public store. Only syncSortedSetFromLeaderboard may rebuild it from a
  // complete sealed generation.
}

function parsePublicationSeason(period: string): LeaderboardPublicationSeason {
  const season = period.toUpperCase()
  if (season !== '7D' && season !== '30D' && season !== '90D') {
    throw new Error(`Unsupported ranking publication season: ${period}`)
  }
  return season
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
  if (!isPublicRankingSourceAllowed(platform)) return null
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
      if (!isPublicRankingSourceAllowed(platform)) continue
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
const DETAIL_HASH_PREFIX = 'ranking:detail:sealed-v1'
const DETAIL_HASH_TTL = 2 * 60 * 60 // 2 hours (same as sorted set)

function detailHashKey(period: string): string {
  return publicRankingCacheKey(`${DETAIL_HASH_PREFIX}:${period.toUpperCase()}`)
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
 *
 * Throws rather than reporting a false zero-success when Redis or any database
 * page is unavailable. The previous implementation treated a later-page query
 * error as end-of-data and replaced the complete live board with that partial
 * prefix.
 */
export async function syncSortedSetFromLeaderboard(
  supabase: SupabaseClient<Database>,
  period: string
): Promise<number> {
  const redis = await getSharedRedis()
  if (!redis) {
    throw new Error('Redis unavailable while rebuilding sealed ranking cache')
  }

  try {
    const season = parsePublicationSeason(period)
    const key = redisKey(season)
    const hashKey = detailHashKey(season)
    const sealedRead = await readSealedRankingGeneration(
      supabase,
      { season, sources: SYNC_RANKING_SOURCES },
      async (publication) => {
        const rows: Array<Record<string, unknown>> = []
        let offset = 0
        const PAGE_SIZE = 1000

        while (true) {
          const { data, error } = await supabase
            .from('leaderboard_ranks')
            .select(SYNC_SELECT_FIELDS)
            .in('source', SYNC_RANKING_SOURCES)
            .eq('season_id', season)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .gt('arena_score', 0)
            .or('is_outlier.is.null,is_outlier.eq.false')
            .order('arena_score', { ascending: false })
            .order('source', { ascending: true })
            .order('source_trader_id', { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1)

          if (error || data === null) {
            throw new Error(
              `Failed to read sealed ${season} ranking page at offset ${offset}: ${
                error?.message ?? 'null response'
              }`
            )
          }
          if (data.length === 0) break

          for (const row of data) {
            if (row === null || typeof row !== 'object' || Array.isArray(row)) {
              throw new Error(`Sealed ${season} ranking page returned an invalid row`)
            }
            rows.push(Object.fromEntries(Object.entries(row)))
          }
          if (data.length < PAGE_SIZE) break
          offset += PAGE_SIZE
        }

        return rows
      },
      { timeoutMs: 10_000 }
    )
    const allTraders = sealedRead.value
    const expectedRowCount = sealedRead.publication.proofs.reduce(
      (total, proof) => total + proof.published_rank_count,
      0
    )

    if (allTraders.length === 0) {
      throw new Error(`Sealed ${season} generation contains no cacheable ranking rows`)
    }
    if (allTraders.length !== expectedRowCount) {
      throw new Error(
        `Sealed ${season} ranking cache read ${allTraders.length} of ${expectedRowCount} published rows`
      )
    }
    if (allTraders.some((trader) => !isPublicRankingSourceAllowed(trader.source))) {
      throw new Error(`Sealed ${season} generation returned a non-public ranking source`)
    }

    // Publish both Redis readers in one transaction. A plain Upstash pipeline
    // is not atomic: DEL could succeed before a later command failed, exposing
    // an empty or partial live board.
    const transaction = redis.multi()
    transaction.del(key)

    const CHUNK_SIZE = 500
    for (let i = 0; i < allTraders.length; i += CHUNK_SIZE) {
      const chunk = allTraders.slice(i, i + CHUNK_SIZE)
      for (const t of chunk) {
        const source = String(t.source)
        const traderId = String(t.source_trader_id)
        transaction.zadd(key, {
          score: Number(t.arena_score),
          member: memberKey(source, traderId),
        })
      }
    }
    transaction.expire(key, TTL_SECONDS)

    // Hash map for trader details (top 200 only to limit memory)
    // Beyond top 200, fallback to DB is acceptable (low traffic)
    const TOP_N_CACHED = 200
    const topTraders = allTraders.slice(0, TOP_N_CACHED)
    transaction.del(hashKey)
    for (const t of topTraders) {
      const member = memberKey(String(t.source), String(t.source_trader_id))
      transaction.hset(hashKey, { [member]: JSON.stringify(t) })
    }
    transaction.expire(hashKey, DETAIL_HASH_TTL)
    await transaction.exec()

    logger.info(
      `[ranking-store] Synced ${allTraders.length} traders to ${key}, ${topTraders.length} details to ${hashKey}`
    )
    return allTraders.length
  } catch (error) {
    logger.error('[ranking-store] syncSortedSetFromLeaderboard failed:', error)
    throw error
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
          const trader = JSON.parse(raw) as Record<string, unknown>
          if (isPublicRankingSourceAllowed(trader.source)) traders.push(trader)
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
