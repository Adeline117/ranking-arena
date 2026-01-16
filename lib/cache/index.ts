/**
 * 缓存管理器
 * 统一管理 Redis 缓存，支持分布式部署环境
 */

import { Redis } from '@upstash/redis'
import { dataLogger } from '@/lib/utils/logger'

// ============================================
// 类型定义
// ============================================

interface CacheOptions {
  /** TTL（秒） */
  ttl?: number
  /** 缓存标签，用于批量失效 */
  tags?: string[]
}

interface CacheStats {
  hits: number
  misses: number
  errors: number
  lastError?: string
}

// ============================================
// Redis 客户端
// ============================================

let redisClient: Redis | null = null
let isInitialized = false

function getRedis(): Redis | null {
  if (!isInitialized) {
    isInitialized = true
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
      dataLogger.warn('Redis 环境变量未配置，使用内存回退')
      return null
    }

    try {
      redisClient = new Redis({ url, token })
    } catch (error) {
      dataLogger.error('Redis 初始化失败:', error)
      return null
    }
  }
  return redisClient
}

// ============================================
// 统计信息
// ============================================

const stats: CacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
}

export function getCacheStats(): CacheStats {
  return { ...stats }
}

export function resetCacheStats(): void {
  stats.hits = 0
  stats.misses = 0
  stats.errors = 0
  stats.lastError = undefined
}

// ============================================
// 缓存操作
// ============================================

/**
 * 从缓存获取数据
 * @param key 缓存键
 * @returns 缓存数据或 null
 */
export async function get<T>(key: string): Promise<T | null> {
  const redis = getRedis()
  if (!redis) return null

  try {
    const data = await redis.get<T>(key)
    if (data !== null) {
      stats.hits++
      return data
    }
    stats.misses++
    return null
  } catch (error) {
    stats.errors++
    stats.lastError = String(error)
    dataLogger.error('缓存读取失败:', { key, error })
    return null
  }
}

/**
 * 设置缓存数据
 * @param key 缓存键
 * @param value 缓存值
 * @param options 选项
 */
export async function set<T>(key: string, value: T, options: CacheOptions = {}): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false

  const { ttl = 60, tags } = options

  try {
    await redis.setex(key, ttl, value)

    // 如果有标签，将键添加到标签集合中
    if (tags && tags.length > 0) {
      const pipeline = redis.pipeline()
      for (const tag of tags) {
        pipeline.sadd(`tag:${tag}`, key)
        // 标签集合的 TTL 设为缓存 TTL 的两倍
        pipeline.expire(`tag:${tag}`, ttl * 2)
      }
      await pipeline.exec()
    }

    return true
  } catch (error) {
    stats.errors++
    stats.lastError = String(error)
    dataLogger.error('缓存写入失败:', { key, error })
    return false
  }
}

/**
 * 删除缓存
 * @param key 缓存键
 */
export async function del(key: string): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false

  try {
    await redis.del(key)
    return true
  } catch (error) {
    stats.errors++
    stats.lastError = String(error)
    dataLogger.error('缓存删除失败:', { key, error })
    return false
  }
}

/**
 * 批量删除缓存（按模式）
 * @param pattern 匹配模式
 */
export async function delByPattern(pattern: string): Promise<number> {
  const redis = getRedis()
  if (!redis) return 0

  try {
    const keys = await redis.keys(pattern)
    if (keys.length === 0) return 0

    await redis.del(...keys)
    return keys.length
  } catch (error) {
    stats.errors++
    stats.lastError = String(error)
    dataLogger.error('批量删除缓存失败:', { pattern, error })
    return 0
  }
}

/**
 * 按标签删除缓存
 * @param tag 标签名
 */
export async function delByTag(tag: string): Promise<number> {
  const redis = getRedis()
  if (!redis) return 0

  try {
    const keys = await redis.smembers(`tag:${tag}`)
    if (keys.length === 0) return 0

    await redis.del(...keys, `tag:${tag}`)
    return keys.length
  } catch (error) {
    stats.errors++
    stats.lastError = String(error)
    dataLogger.error('按标签删除缓存失败:', { tag, error })
    return 0
  }
}

/**
 * 获取或设置缓存（stale-while-revalidate 模式）
 * @param key 缓存键
 * @param fetcher 数据获取函数
 * @param options 选项
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
 * @param key 缓存键
 * @param fetcher 数据获取函数
 * @param options 选项
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

  // 如果 Redis 不可用，直接获取数据
  if (!redis) {
    return await fetcher()
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
 * @param key 缓存键
 */
export async function exists(key: string): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false

  try {
    const result = await redis.exists(key)
    return result === 1
  } catch (error) {
    return false
  }
}

/**
 * 获取缓存剩余 TTL
 * @param key 缓存键
 */
export async function ttl(key: string): Promise<number> {
  const redis = getRedis()
  if (!redis) return -2

  try {
    return await redis.ttl(key)
  } catch (error) {
    return -2
  }
}

/**
 * 增量操作
 * @param key 缓存键
 * @param delta 增量值
 */
export async function incr(key: string, delta: number = 1): Promise<number | null> {
  const redis = getRedis()
  if (!redis) return null

  try {
    return await redis.incrby(key, delta)
  } catch (error) {
    return null
  }
}

// ============================================
// 批量操作
// ============================================

/**
 * 批量获取
 * @param keys 缓存键数组
 */
export async function mget<T>(keys: string[]): Promise<(T | null)[]> {
  const redis = getRedis()
  if (!redis) return keys.map(() => null)

  try {
    const results = await redis.mget<T[]>(...keys)
    results.forEach(r => {
      if (r !== null) stats.hits++
      else stats.misses++
    })
    return results
  } catch (error) {
    stats.errors++
    return keys.map(() => null)
  }
}

/**
 * 批量设置
 * @param entries 键值对数组
 * @param ttl TTL（秒）
 */
export async function mset(
  entries: Array<{ key: string; value: unknown }>,
  ttl: number = 60
): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false

  try {
    const pipeline = redis.pipeline()
    for (const { key, value } of entries) {
      pipeline.setex(key, ttl, value)
    }
    await pipeline.exec()
    return true
  } catch (error) {
    stats.errors++
    return false
  }
}

// ============================================
// 导出键和 TTL 常量
// ============================================

export { CacheKey, CachePattern, CACHE_TTL, CACHE_PREFIX } from './keys'
