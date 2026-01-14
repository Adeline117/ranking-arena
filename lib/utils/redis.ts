/**
 * Upstash Redis 缓存工具
 * 用于分布式缓存，解决 Vercel 多实例缓存不共享问题
 */

import { Redis } from '@upstash/redis'

// 创建 Redis 客户端（单例）
let redisClient: Redis | null = null

export function getRedis(): Redis | null {
  if (!redisClient) {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
      // 开发环境可能没有 Redis，返回 null
      console.warn('[Redis] 缺少环境变量，将使用内存缓存')
      return null
    }

    redisClient = new Redis({ url, token })
  }
  return redisClient
}

/**
 * 从缓存获取数据，如果不存在则调用 fetcher 获取并缓存
 * @param key 缓存键
 * @param fetcher 数据获取函数
 * @param ttlSeconds 过期时间（秒），默认 60 秒
 */
export async function getCachedData<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number = 60
): Promise<T> {
  const redis = getRedis()
  
  // 如果 Redis 不可用，直接调用 fetcher
  if (!redis) {
    return await fetcher()
  }
  
  try {
    // 尝试从缓存获取
    const cached = await redis.get<T>(key)
    if (cached !== null) {
      return cached
    }
  } catch (error) {
    console.warn('[Redis] 获取缓存失败:', error)
    // 缓存失败时继续获取数据
  }

  // 缓存未命中，获取数据
  const data = await fetcher()

  try {
    // 缓存数据
    await redis.setex(key, ttlSeconds, data)
  } catch (error) {
    console.warn('[Redis] 设置缓存失败:', error)
  }

  return data
}

/**
 * 设置缓存
 * @param key 缓存键
 * @param data 数据
 * @param ttlSeconds 过期时间（秒）
 */
export async function setCache<T>(key: string, data: T, ttlSeconds: number = 60): Promise<void> {
  try {
    const redis = getRedis()
    if (!redis) return
    await redis.setex(key, ttlSeconds, data)
  } catch (error) {
    console.warn('[Redis] 设置缓存失败:', error)
  }
}

/**
 * 获取缓存
 * @param key 缓存键
 */
export async function getCache<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis()
    if (!redis) return null
    return await redis.get<T>(key)
  } catch (error) {
    console.warn('[Redis] 获取缓存失败:', error)
    return null
  }
}

/**
 * 删除缓存
 * @param key 缓存键
 */
export async function deleteCache(key: string): Promise<void> {
  try {
    const redis = getRedis()
    if (!redis) return
    await redis.del(key)
  } catch (error) {
    console.warn('[Redis] 删除缓存失败:', error)
  }
}

/**
 * 批量删除缓存（按前缀）
 * @param pattern 匹配模式，如 "traders:*"
 */
export async function deleteCacheByPattern(pattern: string): Promise<void> {
  try {
    const redis = getRedis()
    if (!redis) return
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } catch (error) {
    console.warn('[Redis] 批量删除缓存失败:', error)
  }
}

/**
 * 缓存键生成器
 */
export const CacheKeys = {
  traders: (timeRange: string) => `traders:${timeRange}`,
  trader: (id: string) => `trader:${id}`,
  posts: (groupId?: string, page?: number) => 
    groupId ? `posts:${groupId}:${page || 0}` : `posts:all:${page || 0}`,
  market: () => 'market:prices',
  userProfile: (userId: string) => `user:${userId}:profile`,
} as const

