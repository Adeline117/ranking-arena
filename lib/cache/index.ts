/**
 * 缓存管理器
 * 统一管理 Upstash Redis 缓存，支持分布式部署环境
 * 当 Redis 不可用时自动回退到内存缓存
 * 
 * 注意：在客户端环境下只使用内存缓存，不加载 Redis
 */

import { dataLogger } from '@/lib/utils/logger'
import { getMemoryCache } from './memory-fallback'
import { getSharedRedis, recordRedisError, isRedisAvailable, pingRedis } from './redis-client'
import type { CacheEntry as TieredCacheEntry } from './redis-layer'
import type { ZodSchema } from 'zod'

// ============================================
// 类型定义
// ============================================

interface CacheOptions {
  /** TTL（秒） */
  ttl?: number
  /** 缓存标签，用于批量失效 */
  tags?: string[]
  /** 是否跳过内存缓存 */
  skipMemory?: boolean
}

/**
 * Detect whether a value is a CacheEntry envelope written by redis-layer.ts.
 * If so, unwrap and return the inner data; otherwise return the value as-is.
 */
function unwrapCacheEntry<T>(value: unknown): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    'data' in value &&
    'tier' in value &&
    'cachedAt' in value &&
    'expiresAt' in value
  ) {
    return (value as TieredCacheEntry<T>).data
  }
  return value as T
}

/**
 * Wrap a raw value in the same CacheEntry envelope that redis-layer.ts uses.
 * This ensures both cache layers write the same format to Redis.
 */
function wrapCacheEntry<T>(value: T, ttlSeconds: number): TieredCacheEntry<T> {
  const now = Date.now()
  return {
    data: value,
    tier: 'warm',
    cachedAt: now,
    expiresAt: now + ttlSeconds * 1000,
    softExpiresAt: now + ttlSeconds * 1000,
  }
}

interface CacheStats {
  hits: number
  misses: number
  errors: number
  redisAvailable: boolean
  memoryFallbackActive: boolean
  lastError?: string
}

// ============================================
// Redis 客户端 (shared singleton)
// ============================================

async function getRedis() {
  return getSharedRedis()
}

function handleRedisError(error: unknown): void {
  recordRedisError(error)
  stats.errors++
  stats.lastError = String(error)
}

// ============================================
// 统计信息
// ============================================

const stats: CacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
  redisAvailable: true,
  memoryFallbackActive: false,
}

export function getCacheStats(): CacheStats {
  return {
    ...stats,
    redisAvailable: isRedisAvailable(),
    memoryFallbackActive: !isRedisAvailable(),
  }
}

export function resetCacheStats(): void {
  stats.hits = 0
  stats.misses = 0
  stats.errors = 0
  stats.lastError = undefined
}

// ============================================
// 缓存操作（带回退）
// ============================================

/**
 * 从缓存获取数据
 * L1 内存 → L2 Redis，命中 Redis 后回填内存
 */
export async function get<T>(key: string): Promise<T | null> {
  const memoryCache = getMemoryCache()

  // L1: 内存缓存（零延迟，无网络往返）
  const memoryData = memoryCache.get<T>(key)
  if (memoryData !== null) {
    stats.hits++
    return memoryData
  }

  // L2: Redis
  const redis = await getRedis()
  if (redis) {
    try {
      const raw = await redis.get<T | TieredCacheEntry<T>>(key)
      if (raw !== null) {
        stats.hits++
        const data = unwrapCacheEntry<T>(raw)
        // 回填内存缓存（加速后续访问）
        memoryCache.set(key, data, 60)
        return data
      }
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Redis read failed:', { key, error })
    }
  }

  stats.misses++
  return null
}

/**
 * 设置缓存数据
 * 同时写入 Redis 和内存缓存
 */
export async function set<T>(key: string, value: T, options: CacheOptions = {}): Promise<boolean> {
  const redis = await getRedis()
  const memoryCache = getMemoryCache()
  const { ttl = 120, tags, skipMemory = false } = options

  // 1. 写入内存缓存（始终成功）
  if (!skipMemory) {
    memoryCache.set(key, value, ttl)
  }

  // 2. 尝试写入 Redis (single pipeline for SET + tags)
  // Wrap in CacheEntry envelope for format compatibility with redis-layer.ts
  if (redis) {
    try {
      const entry = wrapCacheEntry(value, ttl)
      if (tags && tags.length > 0) {
        // Pipeline: SET + SADD + EXPIRE in one round-trip
        const pipeline = redis.pipeline()
        pipeline.set(key, entry, { ex: ttl })
        for (const tag of tags) {
          pipeline.sadd(`tag:${tag}`, key)
          pipeline.expire(`tag:${tag}`, ttl * 2)
        }
        await pipeline.exec()
      } else {
        await redis.set(key, entry, { ex: ttl })
      }

      return true
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Upstash Redis 写入失败:', { key, error })
      // 内存缓存已写入，返回 true
      return !skipMemory
    }
  }

  return !skipMemory
}

/**
 * 删除缓存
 */
export async function del(key: string): Promise<boolean> {
  const redis = await getRedis()
  const memoryCache = getMemoryCache()

  // 删除内存缓存
  memoryCache.delete(key)

  // 删除 Redis 缓存
  if (redis) {
    try {
      await redis.del(key)
      return true
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Upstash Redis 删除失败:', { key, error })
    }
  }

  return true
}

/**
 * 批量删除缓存（按模式）
 * 使用 SCAN 替代 KEYS 避免阻塞 Redis
 */
export async function delByPattern(pattern: string): Promise<number> {
  const redis = await getRedis()
  const memoryCache = getMemoryCache()

  // 删除内存缓存（按前缀）
  const prefix = pattern.replace(/\*/g, '')
  const memoryDeleted = memoryCache.deleteByPrefix(prefix)

  // 删除 Redis 缓存
  if (redis) {
    try {
      // 使用 SCAN 迭代删除，避免 KEYS 阻塞
      let totalDeleted = 0
      let cursor = 0

      do {
        // Upstash Redis scan 返回 [cursor, keys]
        const [nextCursor, keys] = await redis.scan(cursor, {
          match: pattern,
          count: 100, // 每次扫描 100 个键
        })

        cursor = Number(nextCursor)

        if (keys.length > 0) {
          await redis.del(...keys)
          totalDeleted += keys.length
        }
      } while (cursor !== 0)

      return totalDeleted
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Upstash Redis 批量删除失败:', { pattern, error })
    }
  }

  return memoryDeleted
}

/**
 * 按标签删除缓存
 */
export async function delByTag(tag: string): Promise<number> {
  const redis = await getRedis()

  if (!redis) return 0

  try {
    const keys = await redis.smembers(`tag:${tag}`)
    if (keys.length === 0) return 0

    // 同时删除内存缓存
    const memoryCache = getMemoryCache()
    for (const key of keys) {
      memoryCache.delete(key)
    }

    await redis.del(...keys, `tag:${tag}`)
    return keys.length
  } catch (error) {
    handleRedisError(error)
    dataLogger.error('按标签删除失败:', { tag, error })
    return 0
  }
}

/**
 * 获取或设置缓存（stale-while-revalidate 模式）
 *
 * When staleTtl is provided and the Redis key has expired but the memory
 * cache still holds stale data, returns stale data immediately and
 * refreshes in the background.
 */
export async function getOrSet<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions & { staleTtl?: number; schema?: ZodSchema<T> } = {}
): Promise<T> {
  // 尝试从缓存获取
  const cached = await get<T>(key)
  if (cached !== null) {
    // Optional Zod schema validation on deserialized cache (prevents schema drift)
    if (options.schema) {
      const result = options.schema.safeParse(cached)
      if (!result.success) {
        dataLogger.warn(`[Cache] Schema validation failed for ${key}, refetching`, {
          errors: result.error.issues.slice(0, 3),
        })
        // Evict invalid cache entry
        del(key).catch(err => dataLogger.warn(`[Cache] Failed to evict invalid cache entry for ${key}`, { error: String(err) }))
      } else {
        return result.data
      }
    } else {
      return cached
    }
  }

  // If staleTtl is set, check memory for stale data and revalidate in background
  if (options.staleTtl) {
    const memoryCache = getMemoryCache()
    // getMemoryCache().get checks expiry — use the raw map for stale check
    const staleData = memoryCache.get<T>(`stale:${key}`)
    if (staleData !== null) {
      // Serve stale, refresh in background
      fetcher().then(fresh => {
        set(key, fresh, options).catch(err => dataLogger.warn(`[Cache] Stale revalidation set failed for ${key}`, { error: String(err) }))
        memoryCache.set(`stale:${key}`, fresh, (options.ttl || 120) + options.staleTtl!)
      }).catch(err => dataLogger.warn(`[Cache] Stale revalidation fetch failed for ${key}`, { error: String(err) }))
      return staleData
    }
  }

  // 缓存未命中，获取新数据
  const data = await fetcher()

  // 异步缓存（不阻塞返回，但记录错误）
  set(key, data, options).catch((err) => {
    dataLogger.warn('Async cache set failed:', { key, error: String(err) })
  })

  // Also store in stale bucket if staleTtl is configured
  if (options.staleTtl) {
    const memoryCache = getMemoryCache()
    memoryCache.set(`stale:${key}`, data, (options.ttl || 120) + options.staleTtl)
  }

  return data
}

/**
 * 带锁的获取或设置（防止缓存击穿/雪崩）
 *
 * 改进:
 * - 指数退避重试获取锁
 * - TTL 抖动防止同时过期
 * - 最大等待时间限制
 */
export async function getOrSetWithLock<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions & {
    lockTtl?: number
    maxWaitMs?: number
    retryDelayMs?: number
    ttlJitter?: boolean
  } = {}
): Promise<T> {
  const redis = await getRedis()
  const {
    ttl = 120,
    lockTtl = 10,
    maxWaitMs = 5000,
    retryDelayMs = 50,
    ttlJitter = true,
  } = options

  // 尝试从缓存获取
  const cached = await get<T>(key)
  if (cached !== null) {
    return cached
  }

  // 计算实际 TTL（添加抖动防止雪崩）
  const actualTtl = ttlJitter ? addTtlJitter(ttl) : ttl

  // 如果 Redis 不可用，直接获取数据并缓存到内存
  if (!redis) {
    const data = await fetcher()
    await set(key, data, { ...options, ttl: actualTtl })
    return data
  }

  const lockKey = `lock:${key}`
  const startTime = Date.now()
  let attempt = 0

  // 指数退避尝试获取锁
  while (Date.now() - startTime < maxWaitMs) {
    attempt++

    try {
      // 尝试获取锁（使用 NX 选项）
      const lockAcquired = await redis.set(lockKey, '1', {
        ex: lockTtl,
        nx: true,
      })

      if (lockAcquired) {
        try {
          // 双重检查：获得锁后再次检查缓存
          const doubleCheck = await get<T>(key)
          if (doubleCheck !== null) {
            return doubleCheck
          }

          // 获得锁，获取数据
          const data = await fetcher()
          await set(key, data, { ...options, ttl: actualTtl })
          return data
        } finally {
          // 释放锁
          await redis.del(lockKey).catch(err => dataLogger.warn(`[Cache] Lock release failed for ${lockKey}`, { error: String(err) }))
        }
      }

      // 未获得锁，检查缓存是否已被其他进程填充
      const retryCache = await get<T>(key)
      if (retryCache !== null) {
        return retryCache
      }
    } catch (lockError) {
      // Redis error (e.g. rate limit exceeded) — fall back to direct fetch
      dataLogger.warn(`[Cache] Redis lock error for ${key}, falling back to direct fetch:`, lockError)
      const data = await fetcher()
      // Try memory cache only
      const memCache = getMemoryCache()
      memCache.set(key, data, actualTtl)
      return data
    }

    // 指数退避等待
    const backoffMs = Math.min(retryDelayMs * Math.pow(2, attempt - 1), 1000)
    const jitter = Math.random() * backoffMs * 0.3 // 30% 抖动
    await new Promise(resolve => setTimeout(resolve, backoffMs + jitter))
  }

  // 超时：执行兜底获取（避免完全失败）
  dataLogger.warn(`[Cache] Lock timeout for ${key}, executing without lock`)
  const data = await fetcher()
  // 异步缓存，不阻塞返回
  set(key, data, { ...options, ttl: actualTtl }).catch((err) => {
    dataLogger.warn(`[Cache] Failed to set cache after lock timeout for ${key}: ${err instanceof Error ? err.message : String(err)}`)
  })
  return data
}

/**
 * 添加 TTL 抖动，防止大量缓存同时过期
 * 在原 TTL 基础上增加 ±10% 的随机偏移
 */
function addTtlJitter(ttl: number): number {
  const jitterRange = Math.floor(ttl * 0.1) // 10% 抖动
  const jitter = Math.floor(Math.random() * jitterRange * 2) - jitterRange
  return Math.max(ttl + jitter, 1)
}

/**
 * 检查缓存是否存在
 */
export async function exists(key: string): Promise<boolean> {
  const redis = await getRedis()
  const memoryCache = getMemoryCache()

  // 先检查内存缓存
  if (memoryCache.has(key)) {
    return true
  }

  // 再检查 Redis
  if (redis) {
    try {
      const result = await redis.exists(key)
      return result === 1
    } catch (error) {
      handleRedisError(error)
    }
  }

  return false
}

/**
 * 获取缓存剩余 TTL
 */
export async function ttl(key: string): Promise<number> {
  const redis = await getRedis()
  if (!redis) return -2

  try {
    return await redis.ttl(key)
  } catch (error) {
    handleRedisError(error)
    return -2
  }
}

/**
 * 增量操作
 */
export async function incr(key: string, delta: number = 1): Promise<number | null> {
  const redis = await getRedis()
  if (!redis) return null

  try {
    return await redis.incrby(key, delta)
  } catch (error) {
    handleRedisError(error)
    return null
  }
}

// ============================================
// 批量操作
// ============================================

/**
 * 批量获取 — checks memory first, then fetches only misses from Redis (single MGET)
 */
export async function mget<T>(keys: string[]): Promise<(T | null)[]> {
  if (keys.length === 0) return []

  const memoryCache = getMemoryCache()
  const results: (T | null)[] = new Array(keys.length).fill(null)

  // 1. Check memory cache first
  const missIndices: number[] = []
  for (let i = 0; i < keys.length; i++) {
    const data = memoryCache.get<T>(keys[i])
    if (data !== null) {
      results[i] = data
      stats.hits++
    } else {
      missIndices.push(i)
    }
  }

  // 2. Batch-fetch only misses from Redis
  if (missIndices.length > 0) {
    const redis = await getRedis()
    if (redis) {
      try {
        const missKeys = missIndices.map(i => keys[i])
        const redisResults = await redis.mget<(T | TieredCacheEntry<T> | null)[]>(...missKeys)
        for (let j = 0; j < missIndices.length; j++) {
          const raw = redisResults[j]
          const idx = missIndices[j]
          if (raw !== null) {
            const val = unwrapCacheEntry<T>(raw)
            results[idx] = val
            stats.hits++
            // Backfill memory cache
            memoryCache.set(keys[idx], val, 60)
          } else {
            stats.misses++
          }
        }
      } catch (error) {
        handleRedisError(error)
        // Count remaining as misses
        for (const idx of missIndices) {
          if (results[idx] === null) stats.misses++
        }
      }
    } else {
      // No Redis — count remaining as misses
      for (const idx of missIndices) {
        if (results[idx] === null) stats.misses++
      }
    }
  }

  return results
}

/**
 * 批量设置
 */
export async function mset(
  entries: Array<{ key: string; value: unknown }>,
  ttlSeconds: number = 60
): Promise<boolean> {
  const redis = await getRedis()
  const memoryCache = getMemoryCache()

  // 写入内存缓存
  for (const { key, value } of entries) {
    memoryCache.set(key, value, ttlSeconds)
  }

  // 写入 Redis (wrap in CacheEntry envelope for format compatibility)
  if (redis) {
    try {
      const pipeline = redis.pipeline()
      for (const { key, value } of entries) {
        const entry = wrapCacheEntry(value, ttlSeconds)
        pipeline.set(key, entry, { ex: ttlSeconds })
      }
      await pipeline.exec()
      return true
    } catch (error) {
      handleRedisError(error)
    }
  }

  return true
}

// ============================================
// 健康检查
// ============================================

/**
 * 手动触发 Redis 健康检查
 */
export async function checkHealth(): Promise<{
  redis: boolean
  memory: { size: number; maxSize: number }
}> {
  const memoryCache = getMemoryCache()
  const redisOk = await pingRedis()

  return {
    redis: redisOk,
    memory: memoryCache.getStats(),
  }
}

/**
 * 强制使用内存缓存（用于测试或紧急情况）
 */
export function forceMemoryOnly(enabled: boolean): void {
  if (!enabled) {
    // Try to recover Redis
    pingRedis().catch((err) => {
      dataLogger.debug('Redis recovery check failed:', err)
    })
  }
  // Note: when enabled=true, recordRedisError will mark unhealthy after threshold
}

// ============================================
// 导出键和 TTL 常量
// ============================================

export { CacheKey, CachePattern, CACHE_TTL, CACHE_PREFIX } from './keys'
export { MemoryCache, getMemoryCache, resetMemoryCache } from './memory-fallback'

// ============================================
// 简单客户端缓存 API（兼容旧代码）
// ============================================

/**
 * 简单获取客户端缓存
 * 用于客户端组件的简单缓存需求
 */
export function getCache<T>(key: string): T | null {
  const memoryCache = getMemoryCache()
  return memoryCache.get<T>(key)
}

/**
 * 简单设置客户端缓存
 * @param key 缓存键
 * @param data 缓存数据
 * @param ttlMs TTL（毫秒），默认 5 分钟
 */
export function setCache<T>(key: string, data: T, ttlMs: number = 5 * 60 * 1000): void {
  const memoryCache = getMemoryCache()
  // 转换为秒
  memoryCache.set(key, data, Math.floor(ttlMs / 1000))
}

/**
 * 清除所有客户端缓存
 */
export function clearCache(): void {
  const memoryCache = getMemoryCache()
  memoryCache.clear()
}
