/**
 * Rankings Cache
 *
 * Specialized cache for trader rankings using Redis Sorted Sets
 * Provides O(log N) ranking queries instead of O(N) with regular caching
 *
 * Features:
 * - Redis Sorted Set for efficient ranking queries
 * - L1 memory cache for hot data
 * - Automatic TTL management
 * - Batch write operations
 * - Real-time score updates
 */

import { dataLogger } from '@/lib/utils/logger'
import { getMemoryCache } from './memory-fallback'

// ============================================
// Types
// ============================================

export interface TraderRankingData {
  trader_key: string
  platform: string
  nickname?: string
  avatar_url?: string
  arena_score: number
  roi: number
  pnl: number
  max_drawdown: number
  copiers_count: number
  win_rate?: number
  rank?: number
}

interface RankingsQueryOptions {
  window: '7d' | '30d' | '90d'
  platform?: string
  limit?: number
  offset?: number
  minScore?: number
  maxScore?: number
}

interface RankingsCacheStats {
  l1Hits: number
  l2Hits: number
  misses: number
  writes: number
  errors: number
}

// ============================================
// Configuration
// ============================================

const CACHE_CONFIG = {
  L1_TTL_SECONDS: 30,       // Local cache TTL
  L2_TTL_SECONDS: 300,      // Redis cache TTL (5 min)
  MAX_L1_ENTRIES: 500,      // Max entries per key in L1
  DEFAULT_LIMIT: 100,       // Default query limit
  KEY_PREFIX: 'rankings',   // Redis key prefix
}

// ============================================
// Redis Client (Lazy Import)
// ============================================

type UpstashRedisType = InstanceType<typeof import('@upstash/redis')['Redis']>
let redisClient: UpstashRedisType | null = null
let redisInitialized = false

async function getRedis(): Promise<UpstashRedisType | null> {
  if (typeof window !== 'undefined') return null
  if (redisInitialized) return redisClient

  redisInitialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    dataLogger.warn('[RankingsCache] Redis not configured')
    return null
  }

  try {
    const { Redis } = await import('@upstash/redis')
    redisClient = new Redis({ url, token })
    dataLogger.info('[RankingsCache] Redis connected')
    return redisClient
  } catch (error) {
    dataLogger.error('[RankingsCache] Redis init failed:', error)
    return null
  }
}

// ============================================
// Statistics
// ============================================

const stats: RankingsCacheStats = {
  l1Hits: 0,
  l2Hits: 0,
  misses: 0,
  writes: 0,
  errors: 0,
}

export function getRankingsCacheStats(): RankingsCacheStats {
  return { ...stats }
}

export function resetRankingsCacheStats(): void {
  stats.l1Hits = 0
  stats.l2Hits = 0
  stats.misses = 0
  stats.writes = 0
  stats.errors = 0
}

// ============================================
// Key Generation
// ============================================

function getSortedSetKey(window: string, platform?: string): string {
  if (platform) {
    return `${CACHE_CONFIG.KEY_PREFIX}:${window}:${platform}`
  }
  return `${CACHE_CONFIG.KEY_PREFIX}:${window}:all`
}

function getL1Key(window: string, platform?: string, limit?: number, offset?: number): string {
  return `l1:${getSortedSetKey(window, platform)}:${limit || 'all'}:${offset || 0}`
}

// ============================================
// Rankings Cache Class
// ============================================

class RankingsCache {
  private memoryCache = getMemoryCache()

  /**
   * Set rankings for a specific window/platform combination
   * Uses Redis Sorted Set with arena_score as the score
   */
  async setRankings(
    window: string,
    platform: string | undefined,
    traders: TraderRankingData[]
  ): Promise<boolean> {
    if (traders.length === 0) return true

    const redis = await getRedis()
    const key = getSortedSetKey(window, platform)

    // Clear L1 cache for this key pattern
    this.invalidateL1(window, platform)

    if (!redis) {
      // Fallback: store in memory as array
      this.memoryCache.set(key, traders, CACHE_CONFIG.L1_TTL_SECONDS)
      stats.writes++
      return true
    }

    try {
      // Use pipeline for batch operations
      const pipeline = redis.pipeline()

      // Delete existing sorted set
      pipeline.del(key)

      // Add all traders to sorted set
      // Score is arena_score (higher = better rank)
      for (const trader of traders) {
        const member = JSON.stringify(trader)
        pipeline.zadd(key, { score: trader.arena_score, member })
      }

      // Set TTL
      pipeline.expire(key, CACHE_CONFIG.L2_TTL_SECONDS)

      await pipeline.exec()
      stats.writes++

      dataLogger.debug(`[RankingsCache] Stored ${traders.length} traders for ${key}`)
      return true
    } catch (error) {
      stats.errors++
      dataLogger.error('[RankingsCache] setRankings error:', error)

      // Fallback to memory
      this.memoryCache.set(key, traders, CACHE_CONFIG.L1_TTL_SECONDS)
      return true
    }
  }

  /**
   * Get top N rankings (most efficient for leaderboard queries)
   */
  async getTopRankings(options: RankingsQueryOptions): Promise<TraderRankingData[]> {
    const { window, platform, limit = CACHE_CONFIG.DEFAULT_LIMIT, offset = 0 } = options
    const l1Key = getL1Key(window, platform, limit, offset)
    const l2Key = getSortedSetKey(window, platform)

    // Check L1 cache first
    const l1Data = this.memoryCache.get<TraderRankingData[]>(l1Key)
    if (l1Data) {
      stats.l1Hits++
      return l1Data
    }

    const redis = await getRedis()

    if (!redis) {
      // Fallback: get from memory as array
      const memoryData = this.memoryCache.get<TraderRankingData[]>(l2Key)
      if (memoryData) {
        stats.l1Hits++
        return memoryData.slice(offset, offset + limit)
      }
      stats.misses++
      return []
    }

    try {
      // Use ZREVRANGE for descending order (highest scores first)
      const results = await redis.zrange(l2Key, offset, offset + limit - 1, { rev: true })

      if (!results || results.length === 0) {
        stats.misses++
        return []
      }

      stats.l2Hits++

      // Parse JSON strings back to objects
      const traders: TraderRankingData[] = results.map((item, index) => {
        const trader = typeof item === 'string' ? JSON.parse(item) : item
        return {
          ...trader,
          rank: offset + index + 1, // Add rank
        }
      })

      // Store in L1 for faster subsequent access
      this.memoryCache.set(l1Key, traders, CACHE_CONFIG.L1_TTL_SECONDS)

      return traders
    } catch (error) {
      stats.errors++
      dataLogger.error('[RankingsCache] getTopRankings error:', error)
      stats.misses++
      return []
    }
  }

  /**
   * Get a specific trader's rank
   */
  async getTraderRank(
    window: string,
    platform: string | undefined,
    traderKey: string
  ): Promise<number | null> {
    const redis = await getRedis()
    if (!redis) return null

    const key = getSortedSetKey(window, platform)

    try {
      // Find the trader in the sorted set
      // We need to search by trader_key, which requires scanning
      const allMembers = await redis.zrange(key, 0, -1, { rev: true })

      for (let i = 0; i < allMembers.length; i++) {
        const rawMember = allMembers[i]
        const member = typeof rawMember === 'string'
          ? JSON.parse(rawMember)
          : rawMember
        if (member.trader_key === traderKey) {
          return i + 1 // Rank is 1-indexed
        }
      }

      return null
    } catch (error) {
      stats.errors++
      dataLogger.error('[RankingsCache] getTraderRank error:', error)
      return null
    }
  }

  /**
   * Update a single trader's score (for real-time updates)
   */
  async updateTraderScore(
    window: string,
    platform: string | undefined,
    trader: TraderRankingData
  ): Promise<boolean> {
    const redis = await getRedis()
    if (!redis) return false

    const key = getSortedSetKey(window, platform)

    try {
      // Remove old entry by matching trader_key (requires scan)
      const allMembers = await redis.zrange(key, 0, -1)

      for (const member of allMembers) {
        const data = typeof member === 'string' ? JSON.parse(member) : member
        if (data.trader_key === trader.trader_key) {
          await redis.zrem(key, member)
          break
        }
      }

      // Add updated entry
      await redis.zadd(key, { score: trader.arena_score, member: JSON.stringify(trader) })

      // Invalidate L1 cache
      this.invalidateL1(window, platform)

      stats.writes++
      return true
    } catch (error) {
      stats.errors++
      dataLogger.error('[RankingsCache] updateTraderScore error:', error)
      return false
    }
  }

  /**
   * Get rankings count
   */
  async getRankingsCount(window: string, platform?: string): Promise<number> {
    const redis = await getRedis()
    if (!redis) return 0

    const key = getSortedSetKey(window, platform)

    try {
      return await redis.zcard(key)
    } catch (_error) {
      stats.errors++
      return 0
    }
  }

  /**
   * Get rankings by score range
   */
  async getRankingsByScoreRange(
    window: string,
    platform: string | undefined,
    minScore: number,
    maxScore: number,
    limit: number = 100
  ): Promise<TraderRankingData[]> {
    const redis = await getRedis()
    if (!redis) return []

    const key = getSortedSetKey(window, platform)

    try {
      // Use zrange with byScore option (zrangebyscore was deprecated)
      const results = await redis.zrange(key, minScore, maxScore, {
        byScore: true,
        count: limit,
        offset: 0,
      })

      if (!results || results.length === 0) {
        return []
      }

      return results.map((item: unknown) => {
        return typeof item === 'string' ? JSON.parse(item) : item
      })
    } catch (error) {
      stats.errors++
      dataLogger.error('[RankingsCache] getRankingsByScoreRange error:', error)
      return []
    }
  }

  /**
   * Invalidate L1 cache for a specific window/platform
   */
  private invalidateL1(window: string, platform?: string): void {
    const pattern = `l1:${CACHE_CONFIG.KEY_PREFIX}:${window}:${platform || 'all'}`
    this.memoryCache.deleteByPrefix(pattern)
  }

  /**
   * Invalidate all rankings cache for a window
   */
  async invalidateWindow(window: string): Promise<void> {
    const redis = await getRedis()

    // Clear L1
    this.memoryCache.deleteByPrefix(`l1:${CACHE_CONFIG.KEY_PREFIX}:${window}`)

    // Clear L2
    if (redis) {
      try {
        const keys = await redis.keys(`${CACHE_CONFIG.KEY_PREFIX}:${window}:*`)
        if (keys.length > 0) {
          await redis.del(...keys)
        }
      } catch (error) {
        stats.errors++
        dataLogger.error('[RankingsCache] invalidateWindow error:', error)
      }
    }
  }

  /**
   * Warm up cache with fresh data
   */
  async warmUp(
    window: string,
    platforms: string[],
    fetchFn: (platform: string) => Promise<TraderRankingData[]>
  ): Promise<void> {
    dataLogger.info(`[RankingsCache] Warming up cache for ${window}`)

    const promises = platforms.map(async (platform) => {
      try {
        const traders = await fetchFn(platform)
        await this.setRankings(window, platform, traders)
        dataLogger.debug(`[RankingsCache] Warmed ${platform}: ${traders.length} traders`)
      } catch (error) {
        dataLogger.error(`[RankingsCache] Warm-up failed for ${platform}:`, error)
      }
    })

    await Promise.all(promises)
    dataLogger.info(`[RankingsCache] Cache warm-up complete for ${window}`)
  }
}

// ============================================
// Export Singleton
// ============================================

export const rankingsCache = new RankingsCache()

// Export types
export type { RankingsQueryOptions, RankingsCacheStats }
