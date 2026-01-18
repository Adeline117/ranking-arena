/**
 * 缓存管理器
 * 统一管理 Redis 缓存，支持分布式部署环境
 * 当 Redis 不可用时自动回退到内存缓存
 */

import { Redis } from '@upstash/redis'
import { dataLogger } from '@/lib/utils/logger'
import { getMemoryCache, MemoryCache } from './memory-fallback'

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

interface CacheStats {
  hits: number
  misses: number
  errors: number
  redisAvailable: boolean
  memoryFallbackActive: boolean
  lastError?: string
}

// ============================================
// Redis 客户端状态
// ============================================

let redisClient: Redis | null = null
let isInitialized = false
let redisHealthy = true
let lastHealthCheck = 0
const HEALTH_CHECK_INTERVAL = 30000 // 30 秒健康检查间隔
const MAX_CONSECUTIVE_ERRORS = 3
let consecutiveErrors = 0

function getRedis(): Redis | null {
  if (!isInitialized) {
    isInitialized = true
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
      dataLogger.warn('Redis 环境变量未配置，使用内存缓存')
      redisHealthy = false
      return null
    }

    try {
      redisClient = new Redis({ url, token })
    } catch (error) {
      dataLogger.error('Redis 初始化失败:', error)
      redisHealthy = false
      return null
    }
  }

  // 如果 Redis 被标记为不健康，检查是否需要重试
  if (!redisHealthy && redisClient) {
    const now = Date.now()
    if (now - lastHealthCheck > HEALTH_CHECK_INTERVAL) {
      lastHealthCheck = now
      // 异步进行健康检查
      checkRedisHealth().catch(() => {})
    }
  }

  return redisHealthy ? redisClient : null
}

/**
 * 检查 Redis 健康状态
 */
async function checkRedisHealth(): Promise<boolean> {
  if (!redisClient) return false

  try {
    await redisClient.ping()
    if (!redisHealthy) {
      dataLogger.info('Redis 连接已恢复')
    }
    redisHealthy = true
    consecutiveErrors = 0
    return true
  } catch (error) {
    redisHealthy = false
    dataLogger.warn('Redis 健康检查失败:', error)
    return false
  }
}

/**
 * 处理 Redis 错误，决定是否启用回退
 */
function handleRedisError(error: unknown): void {
  consecutiveErrors++
  stats.errors++
  stats.lastError = String(error)

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    if (redisHealthy) {
      dataLogger.warn(`Redis 连续 ${consecutiveErrors} 次错误，切换到内存缓存`)
      redisHealthy = false
      lastHealthCheck = Date.now()
    }
  }
}

/**
 * 获取内存缓存实例
 */
function getMemoryCacheFallback(): MemoryCache {
  return getMemoryCache()
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
    redisAvailable: redisHealthy,
    memoryFallbackActive: !redisHealthy,
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
 * 优先使用 Redis，失败时回退到内存缓存
 */
export async function get<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

  // 1. 尝试从 Redis 获取
  if (redis) {
    try {
      const data = await redis.get<T>(key)
      if (data !== null) {
        stats.hits++
        // 同时更新内存缓存（加速后续访问）
        memoryCache.set(key, data, 60)
        return data
      }
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Redis 读取失败，尝试内存缓存:', { key, error })
    }
  }

  // 2. 从内存缓存获取
  const memoryData = memoryCache.get<T>(key)
  if (memoryData !== null) {
    stats.hits++
    return memoryData
  }

  stats.misses++
  return null
}

/**
 * 设置缓存数据
 * 同时写入 Redis 和内存缓存
 */
export async function set<T>(key: string, value: T, options: CacheOptions = {}): Promise<boolean> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()
  const { ttl = 60, tags, skipMemory = false } = options

  // 1. 写入内存缓存（始终成功）
  if (!skipMemory) {
    memoryCache.set(key, value, ttl)
  }

  // 2. 尝试写入 Redis
  if (redis) {
    try {
      await redis.setex(key, ttl, value)

      // 如果有标签，将键添加到标签集合中
      if (tags && tags.length > 0) {
        const pipeline = redis.pipeline()
        for (const tag of tags) {
          pipeline.sadd(`tag:${tag}`, key)
          pipeline.expire(`tag:${tag}`, ttl * 2)
        }
        await pipeline.exec()
      }

      return true
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Redis 写入失败:', { key, error })
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
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

  // 删除内存缓存
  memoryCache.delete(key)

  // 删除 Redis 缓存
  if (redis) {
    try {
      await redis.del(key)
      return true
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Redis 删除失败:', { key, error })
    }
  }

  return true
}

/**
 * 批量删除缓存（按模式）
 */
export async function delByPattern(pattern: string): Promise<number> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

  // 删除内存缓存（按前缀）
  const prefix = pattern.replace(/\*/g, '')
  const memoryDeleted = memoryCache.deleteByPrefix(prefix)

  // 删除 Redis 缓存
  if (redis) {
    try {
      const keys = await redis.keys(pattern)
      if (keys.length > 0) {
        await redis.del(...keys)
        return keys.length
      }
    } catch (error) {
      handleRedisError(error)
      dataLogger.error('Redis 批量删除失败:', { pattern, error })
    }
  }

  return memoryDeleted
}

/**
 * 按标签删除缓存
 */
export async function delByTag(tag: string): Promise<number> {
  const redis = getRedis()

  if (!redis) return 0

  try {
    const keys = await redis.smembers(`tag:${tag}`)
    if (keys.length === 0) return 0

    // 同时删除内存缓存
    const memoryCache = getMemoryCacheFallback()
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
 */
export async function getOrSet<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {}
): Promise<T> {
  // 尝试从缓存获取
  const cached = await get<T>(key)
  if (cached !== null) {
    return cached
  }

  // 缓存未命中，获取新数据
  const data = await fetcher()

  // 异步缓存（不阻塞返回）
  set(key, data, options).catch(() => {
    // 静默处理缓存错误
  })

  return data
}

/**
 * 带锁的获取或设置（防止缓存击穿）
 */
export async function getOrSetWithLock<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: CacheOptions & { lockTtl?: number } = {}
): Promise<T> {
  const redis = getRedis()
  const { ttl = 60, lockTtl = 5 } = options

  // 尝试从缓存获取
  const cached = await get<T>(key)
  if (cached !== null) {
    return cached
  }

  // 如果 Redis 不可用，直接获取数据并缓存到内存
  if (!redis) {
    const data = await fetcher()
    await set(key, data, { ttl })
    return data
  }

  // 尝试获取锁
  const lockKey = `lock:${key}`
  const lockAcquired = await redis.set(lockKey, '1', {
    ex: lockTtl,
    nx: true,
  })

  if (!lockAcquired) {
    // 未获得锁，等待并重试获取缓存
    await new Promise(resolve => setTimeout(resolve, 100))
    const retryCache = await get<T>(key)
    if (retryCache !== null) {
      return retryCache
    }
    // 仍然没有，直接获取（避免死锁）
    return await fetcher()
  }

  try {
    // 获得锁，获取数据
    const data = await fetcher()
    await set(key, data, { ttl })
    return data
  } finally {
    // 释放锁
    await redis.del(lockKey)
  }
}

/**
 * 检查缓存是否存在
 */
export async function exists(key: string): Promise<boolean> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

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
  const redis = getRedis()
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
  const redis = getRedis()
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
 * 批量获取
 */
export async function mget<T>(keys: string[]): Promise<(T | null)[]> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

  if (redis) {
    try {
      const results = await redis.mget<T[]>(...keys)
      results.forEach((r, i) => {
        if (r !== null) {
          stats.hits++
          // 同步到内存缓存
          memoryCache.set(keys[i], r, 60)
        } else {
          stats.misses++
        }
      })
      return results
    } catch (error) {
      handleRedisError(error)
    }
  }

  // 从内存缓存获取
  return keys.map(key => {
    const data = memoryCache.get<T>(key)
    if (data !== null) stats.hits++
    else stats.misses++
    return data
  })
}

/**
 * 批量设置
 */
export async function mset(
  entries: Array<{ key: string; value: unknown }>,
  ttl: number = 60
): Promise<boolean> {
  const redis = getRedis()
  const memoryCache = getMemoryCacheFallback()

  // 写入内存缓存
  for (const { key, value } of entries) {
    memoryCache.set(key, value, ttl)
  }

  // 写入 Redis
  if (redis) {
    try {
      const pipeline = redis.pipeline()
      for (const { key, value } of entries) {
        pipeline.setex(key, ttl, value)
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
  const memoryCache = getMemoryCacheFallback()
  const redisOk = await checkRedisHealth()

  return {
    redis: redisOk,
    memory: memoryCache.getStats(),
  }
}

/**
 * 强制使用内存缓存（用于测试或紧急情况）
 */
export function forceMemoryOnly(enabled: boolean): void {
  if (enabled) {
    redisHealthy = false
  } else {
    // 尝试恢复 Redis
    checkRedisHealth().catch(() => {})
  }
}

// ============================================
// 导出键和 TTL 常量
// ============================================

export { CacheKey, CachePattern, CACHE_TTL, CACHE_PREFIX } from './keys'
export { MemoryCache, getMemoryCache, resetMemoryCache } from './memory-fallback'