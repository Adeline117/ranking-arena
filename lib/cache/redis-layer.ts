/**
 * Redis 缓存分层优化模块
 * 
 * 设计缓存策略：
 * - 热数据 → Redis (高频访问，短TTL)
 * - 温数据 → Redis (中频访问，中等TTL)
 * - 冷数据 → CDN/Supabase (低频访问，长TTL或持久化)
 * 
 * 缓存层级：
 * - L1: 内存缓存 (单实例，最快)
 * - L2: Redis (分布式，快)
 * - L3: CDN/Supabase (持久化，慢)
 */

import { dataLogger } from '@/lib/utils/logger'
import { getMemoryCache } from './memory-fallback'

// Correlation ID support — logs cache operations with the current request's correlation ID
let _getCorrelationId: (() => string | undefined) | null = null
function correlationId(): string | undefined {
  if (typeof window !== 'undefined') return undefined
  if (!_getCorrelationId) {
    try {
      const mod = '@/lib/api/' + 'correlation'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _getCorrelationId = require(mod).getCorrelationId
    } catch {
      _getCorrelationId = () => undefined
    }
  }
  return _getCorrelationId!()
}

// ============================================
// 类型定义
// ============================================

export type CacheTier = 'hot' | 'warm' | 'cold'
export type CacheLayer = 'memory' | 'redis' | 'persistent'

export interface TieredCacheConfig {
  /** 缓存键 */
  key: string
  /** 缓存层级 */
  tier: CacheTier
  /** 标签（用于批量失效） */
  tags?: string[]
}

export interface CacheEntry<T> {
  data: T
  tier: CacheTier
  cachedAt: number
  expiresAt: number
}

export interface LayerStats {
  memory: { hits: number; misses: number; size: number }
  redis: { hits: number; misses: number; available: boolean }
}

// ============================================
// 缓存配置
// ============================================

export const CACHE_TIERS = {
  /**
   * 热数据：排行榜首页、热门交易员
   * - 高频访问（>100次/分钟）
   * - 短 TTL（5分钟）
   * - 同时缓存到内存和 Redis
   */
  hot: {
    memoryTtlSeconds: 60,       // 内存缓存 1 分钟
    redisTtlSeconds: 300,       // Redis 缓存 5 分钟
    staleWhileRevalidate: 30,   // 允许 30 秒过期数据
    priority: 1,
  },
  
  /**
   * 温数据：交易员详情页、筛选结果
   * - 中频访问（10-100次/分钟）
   * - 中等 TTL（15分钟）
   * - 主要缓存到 Redis
   */
  warm: {
    memoryTtlSeconds: 120,      // 内存缓存 2 分钟
    redisTtlSeconds: 900,       // Redis 缓存 15 分钟
    staleWhileRevalidate: 60,   // 允许 1 分钟过期数据
    priority: 2,
  },
  
  /**
   * 冷数据：历史数据、统计聚合
   * - 低频访问（<10次/分钟）
   * - 长 TTL（1小时+）
   * - 优先从持久化层读取
   */
  cold: {
    memoryTtlSeconds: 300,      // 内存缓存 5 分钟
    redisTtlSeconds: 3600,      // Redis 缓存 1 小时
    staleWhileRevalidate: 300,  // 允许 5 分钟过期数据
    priority: 3,
  },
} as const

/**
 * 预定义缓存键模式和层级
 */
export const CACHE_KEY_PATTERNS = {
  // 排行榜相关 - 热数据
  rankings: {
    pattern: 'rankings:*',
    tier: 'hot' as CacheTier,
    keyBuilder: (seasonId: string, category?: string) => 
      `rankings:${seasonId}${category ? `:${category}` : ''}`,
  },
  
  // 排行榜汇总 - 热数据
  rankingsSummary: {
    pattern: 'rankings:summary:*',
    tier: 'hot' as CacheTier,
    keyBuilder: (seasonId: string) => `rankings:summary:${seasonId}`,
  },
  
  // 交易员详情 - 温数据
  traderDetail: {
    pattern: 'trader:*',
    tier: 'warm' as CacheTier,
    keyBuilder: (platform: string, traderId: string) => 
      `trader:${platform}:${traderId}`,
  },
  
  // 交易员历史 - 冷数据
  traderHistory: {
    pattern: 'trader:history:*',
    tier: 'cold' as CacheTier,
    keyBuilder: (platform: string, traderId: string, period: string) => 
      `trader:history:${platform}:${traderId}:${period}`,
  },
  
  // 平台统计 - 温数据
  platformStats: {
    pattern: 'platform:stats:*',
    tier: 'warm' as CacheTier,
    keyBuilder: (platform: string) => `platform:stats:${platform}`,
  },
  
  // 数据新鲜度 - 热数据
  dataFreshness: {
    pattern: 'freshness:*',
    tier: 'hot' as CacheTier,
    keyBuilder: (source: string) => `freshness:${source}`,
  },
} as const

// ============================================
// Redis 客户端管理 (shared with index.ts)
// ============================================

import { getSharedRedis, isRedisAvailable } from './redis-client'

async function initRedis() {
  return getSharedRedis()
}

// Alias for stats
function getRedisAvailable(): boolean {
  return isRedisAvailable()
}

// ============================================
// 统计追踪
// ============================================

const layerStats: LayerStats = {
  memory: { hits: 0, misses: 0, size: 0 },
  redis: { hits: 0, misses: 0, available: false },
}

export function getLayerStats(): LayerStats {
  const memoryCache = getMemoryCache()
  return {
    ...layerStats,
    memory: { ...layerStats.memory, size: memoryCache.getStats().size },
    redis: { ...layerStats.redis, available: getRedisAvailable() },
  }
}

export function resetLayerStats(): void {
  layerStats.memory.hits = 0
  layerStats.memory.misses = 0
  layerStats.redis.hits = 0
  layerStats.redis.misses = 0
}

// ============================================
// 分层缓存操作
// ============================================

/**
 * 从分层缓存获取数据
 * 按顺序尝试：内存 → Redis → 持久化层
 */
export async function tieredGet<T>(
  key: string,
  tier: CacheTier = 'warm'
): Promise<{ data: T | null; layer: CacheLayer | null }> {
  const memoryCache = getMemoryCache()
  const config = CACHE_TIERS[tier]
  
  // L1: 内存缓存
  const memoryData = memoryCache.get<CacheEntry<T>>(key)
  if (memoryData?.data !== undefined) {
    layerStats.memory.hits++
    return { data: memoryData.data, layer: 'memory' }
  }
  layerStats.memory.misses++
  
  // L2: Redis 缓存
  const redis = await initRedis()
  if (redis) {
    try {
      const redisData = await redis.get<CacheEntry<T>>(key)
      if (redisData?.data !== undefined) {
        layerStats.redis.hits++
        
        // 回填到内存缓存
        memoryCache.set(key, redisData, config.memoryTtlSeconds)
        
        return { data: redisData.data, layer: 'redis' }
      }
      layerStats.redis.misses++
    } catch (error) {
      dataLogger.warn('[RedisLayer] Redis 读取失败:', { key, error, correlationId: correlationId() })
    }
  }
  
  return { data: null, layer: null }
}

/**
 * 写入分层缓存
 */
export async function tieredSet<T>(
  key: string,
  data: T,
  tier: CacheTier = 'warm',
  tags?: string[]
): Promise<boolean> {
  const memoryCache = getMemoryCache()
  const config = CACHE_TIERS[tier]
  const now = Date.now()
  
  const entry: CacheEntry<T> = {
    data,
    tier,
    cachedAt: now,
    expiresAt: now + config.redisTtlSeconds * 1000,

  }
  
  // L1: 写入内存缓存
  memoryCache.set(key, entry, config.memoryTtlSeconds)
  
  // L2: 写入 Redis (single pipeline when tags present)
  const redis = await initRedis()
  if (redis) {
    try {
      if (tags && tags.length > 0) {
        const pipeline = redis.pipeline()
        pipeline.set(key, entry, { ex: config.redisTtlSeconds })
        for (const tag of tags) {
          pipeline.sadd(`tag:${tag}`, key)
          pipeline.expire(`tag:${tag}`, config.redisTtlSeconds * 2)
        }
        await pipeline.exec()
      } else {
        await redis.set(key, entry, { ex: config.redisTtlSeconds })
      }

      return true
    } catch (error) {
      dataLogger.warn('[RedisLayer] Redis 写入失败:', { key, error, correlationId: correlationId() })
    }
  }
  
  return true // 内存缓存已写入
}

/**
 * 删除缓存
 */
export async function tieredDel(key: string): Promise<void> {
  const memoryCache = getMemoryCache()
  
  // 删除内存缓存
  memoryCache.delete(key)
  
  // 删除 Redis 缓存
  const redis = await initRedis()
  if (redis) {
    try {
      await redis.del(key)
    } catch (error) {
      dataLogger.warn('[RedisLayer] Redis 删除失败:', { key, error })
    }
  }
}

/**
 * 按标签批量删除
 */
export async function tieredDelByTag(tag: string): Promise<number> {
  const redis = await initRedis()
  const memoryCache = getMemoryCache()
  
  if (!redis) {
    return memoryCache.deleteByPrefix(`tag:${tag}`)
  }
  
  try {
    const keys = await redis.smembers(`tag:${tag}`)
    if (keys.length === 0) return 0
    
    // 删除内存和 Redis 缓存
    for (const key of keys) {
      memoryCache.delete(key)
    }
    
    await redis.del(...keys, `tag:${tag}`)
    return keys.length
  } catch (error) {
    dataLogger.warn('[RedisLayer] 按标签删除失败:', { tag, error })
    return 0
  }
}

// ============================================
// 高级缓存操作
// ============================================

/**
 * 获取或设置缓存（带 stale-while-revalidate）
 *
 * When the primary cache misses but stale data exists in the extended
 * memory bucket, serves stale data immediately and refreshes in background.
 */
// In-flight request dedup map — prevents cache stampede (thundering herd)
const inFlightRequests = new Map<string, Promise<unknown>>()

export async function tieredGetOrSet<T>(
  key: string,
  fetcher: () => Promise<T>,
  tier: CacheTier = 'warm',
  tags?: string[]
): Promise<T> {
  // 尝试获取缓存
  const { data } = await tieredGet<T>(key, tier)

  if (data !== null) {
    return data
  }

  // Check stale-while-revalidate bucket in memory
  const config = CACHE_TIERS[tier]
  if (config.staleWhileRevalidate > 0) {
    const memoryCache = getMemoryCache()
    const staleEntry = memoryCache.get<CacheEntry<T>>(`swr:${key}`)
    if (staleEntry?.data !== undefined) {
      // Serve stale, refresh in background
      fetcher().then(fresh => {
        tieredSet(key, fresh, tier, tags).catch(err => console.warn(`[redis-layer] SWR set failed for ${key}:`, err instanceof Error ? err.message : String(err)))
      }).catch(err => console.warn(`[redis-layer] SWR fetch failed for ${key}:`, err instanceof Error ? err.message : String(err)))
      return staleEntry.data
    }
  }

  // Coalesce concurrent fetches for the same key (stampede protection)
  const existing = inFlightRequests.get(key) as Promise<T> | undefined
  if (existing) {
    return existing
  }

  // 缓存未命中，获取新数据
  const promise = fetcher().catch(err => {
    inFlightRequests.delete(key)
    throw err
  })
  inFlightRequests.set(key, promise)
  const freshData = await promise
  inFlightRequests.delete(key)

  // 异步写入缓存+ SWR bucket
  tieredSet(key, freshData, tier, tags).catch((err) => {
    dataLogger.warn('[RedisLayer] 缓存写入失败:', { key, error: err })
  })

  // Store in SWR bucket with extended TTL
  if (config.staleWhileRevalidate > 0) {
    const memoryCache = getMemoryCache()
    const swrEntry: CacheEntry<T> = {
      data: freshData,
      tier,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (config.redisTtlSeconds + config.staleWhileRevalidate) * 1000,
  
    }
    memoryCache.set(`swr:${key}`, swrEntry, config.redisTtlSeconds + config.staleWhileRevalidate)
  }

  return freshData
}

/**
 * Batch get from tiered cache — checks memory first, then MGET for Redis misses.
 * Returns results in the same order as keys. Null for misses.
 */
export async function tieredMget<T>(
  keys: string[],
  tier: CacheTier = 'warm'
): Promise<(T | null)[]> {
  if (keys.length === 0) return []

  const memoryCache = getMemoryCache()
  const config = CACHE_TIERS[tier]
  const results: (T | null)[] = new Array(keys.length).fill(null)

  // 1. Check memory cache
  const missIndices: number[] = []
  for (let i = 0; i < keys.length; i++) {
    const memoryData = memoryCache.get<CacheEntry<T>>(keys[i])
    if (memoryData?.data !== undefined) {
      results[i] = memoryData.data
      layerStats.memory.hits++
    } else {
      layerStats.memory.misses++
      missIndices.push(i)
    }
  }

  // 2. Batch-fetch misses from Redis
  if (missIndices.length > 0) {
    const redis = await initRedis()
    if (redis) {
      try {
        const missKeys = missIndices.map(i => keys[i])
        const redisResults = await redis.mget<(CacheEntry<T> | null)[]>(...missKeys)
        for (let j = 0; j < missIndices.length; j++) {
          const entry = redisResults[j]
          const idx = missIndices[j]
          if (entry?.data !== undefined) {
            results[idx] = entry.data
            layerStats.redis.hits++
            // Backfill memory
            memoryCache.set(keys[idx], entry, config.memoryTtlSeconds)
          } else {
            layerStats.redis.misses++
          }
        }
      } catch (error) {
        dataLogger.warn('[RedisLayer] MGET failed:', { error, count: missIndices.length })
      }
    }
  }

  return results
}

/**
 * 预热缓存（批量写入）
 */
export async function warmupCache<T>(
  entries: Array<{ key: string; data: T; tier?: CacheTier; tags?: string[] }>
): Promise<number> {
  let successCount = 0
  
  const redis = await initRedis()
  const memoryCache = getMemoryCache()
  
  const now = Date.now()
  const pipelineOps: Array<{ key: string; value: CacheEntry<T>; ttl: number }> = []

  for (const entry of entries) {
    const tier = entry.tier || 'warm'
    const config = CACHE_TIERS[tier]

    const cacheEntry: CacheEntry<T> = {
      data: entry.data,
      tier,
      cachedAt: now,
      expiresAt: now + config.redisTtlSeconds * 1000,
  
    }

    // 写入内存
    memoryCache.set(entry.key, cacheEntry, config.memoryTtlSeconds)
    pipelineOps.push({ key: entry.key, value: cacheEntry, ttl: config.redisTtlSeconds })
  }

  // 批量写入 Redis（单次网络往返）
  if (redis && pipelineOps.length > 0) {
    try {
      const pipeline = redis.pipeline()
      for (const op of pipelineOps) {
        pipeline.set(op.key, op.value, { ex: op.ttl })
      }
      const results = await pipeline.exec()
      successCount = results.filter(r => r !== null && r !== undefined).length
    } catch (error) {
      dataLogger.warn('[RedisLayer] 批量预热写入失败:', { error, count: pipelineOps.length })
    }
  } else {
    successCount = entries.length // 内存写入成功也算
  }
  
  dataLogger.info(`[RedisLayer] 缓存预热完成: ${successCount}/${entries.length}`)
  return successCount
}

// ============================================
// 排行榜专用缓存 API
// ============================================

/**
 * 缓存排行榜数据（热数据）
 */
export async function cacheRankings<T>(
  seasonId: string,
  data: T,
  category?: string
): Promise<void> {
  const key = CACHE_KEY_PATTERNS.rankings.keyBuilder(seasonId, category)
  await tieredSet(key, data, 'hot', ['rankings', `season:${seasonId}`])
}

/**
 * 获取缓存的排行榜数据
 */
export async function getCachedRankings<T>(
  seasonId: string,
  category?: string
): Promise<T | null> {
  const key = CACHE_KEY_PATTERNS.rankings.keyBuilder(seasonId, category)
  const { data } = await tieredGet<T>(key, 'hot')
  return data
}

/**
 * 缓存交易员详情（温数据）
 */
export async function cacheTraderDetail<T>(
  platform: string,
  traderId: string,
  data: T
): Promise<void> {
  const key = CACHE_KEY_PATTERNS.traderDetail.keyBuilder(platform, traderId)
  await tieredSet(key, data, 'warm', ['trader', `platform:${platform}`])
}

/**
 * 获取缓存的交易员详情
 */
export async function getCachedTraderDetail<T>(
  platform: string,
  traderId: string
): Promise<T | null> {
  const key = CACHE_KEY_PATTERNS.traderDetail.keyBuilder(platform, traderId)
  const { data } = await tieredGet<T>(key, 'warm')
  return data
}

/**
 * 缓存交易员历史数据（冷数据）
 */
export async function cacheTraderHistory<T>(
  platform: string,
  traderId: string,
  period: string,
  data: T
): Promise<void> {
  const key = CACHE_KEY_PATTERNS.traderHistory.keyBuilder(platform, traderId, period)
  await tieredSet(key, data, 'cold', ['history', `platform:${platform}`])
}

/**
 * 获取缓存的交易员历史数据
 */
export async function getCachedTraderHistory<T>(
  platform: string,
  traderId: string,
  period: string
): Promise<T | null> {
  const key = CACHE_KEY_PATTERNS.traderHistory.keyBuilder(platform, traderId, period)
  const { data } = await tieredGet<T>(key, 'cold')
  return data
}

/**
 * 失效某个赛季的所有排行榜缓存
 */
export async function invalidateRankingsCache(seasonId: string): Promise<number> {
  return await tieredDelByTag(`season:${seasonId}`)
}

/**
 * 失效某个平台的所有缓存
 */
export async function invalidatePlatformCache(platform: string): Promise<number> {
  return await tieredDelByTag(`platform:${platform}`)
}

// ============================================
// 健康检查
// ============================================

export async function checkCacheHealth(): Promise<{
  redis: { available: boolean; latencyMs: number | null }
  memory: { size: number; maxSize: number }
  stats: LayerStats
}> {
  const memoryCache = getMemoryCache()
  let redisLatency: number | null = null
  
  const redis = await initRedis()
  if (redis) {
    try {
      const start = Date.now()
      await redis.ping()
      redisLatency = Date.now() - start
    } catch (err) {
      dataLogger.warn('[Redis] Health check failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  return {
    redis: { available: getRedisAvailable(), latencyMs: redisLatency },
    memory: memoryCache.getStats(),
    stats: getLayerStats(),
  }
}
