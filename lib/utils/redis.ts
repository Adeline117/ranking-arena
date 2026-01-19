/**
 * Redis Cloud 缓存工具
 * 用于分布式缓存，解决 Vercel 多实例缓存不共享问题
 */

import { createClient, RedisClientType } from 'redis'

// 创建 Redis 客户端（单例）
let redisClient: RedisClientType | null = null
let isConnecting = false
let connectionFailed = false

export async function getRedis(): Promise<RedisClientType | null> {
  if (connectionFailed) {
    return null
  }

  if (redisClient && redisClient.isOpen) {
    return redisClient
  }

  if (isConnecting) {
    await new Promise(resolve => setTimeout(resolve, 100))
    return redisClient && redisClient.isOpen ? redisClient : null
  }

  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT
  const password = process.env.REDIS_PASSWORD
  const username = process.env.REDIS_USERNAME || 'default'

  if (!host || !password) {
    console.warn('[Redis] 缺少环境变量，将使用内存缓存')
    connectionFailed = true
    return null
  }

  isConnecting = true

  try {
    redisClient = createClient({
      username,
      password,
      socket: {
        host,
        port: parseInt(port || '6379', 10),
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            connectionFailed = true
            return false
          }
          return Math.min(retries * 100, 1000)
        },
      },
    })

    redisClient.on('error', (err) => {
      console.error('[Redis] 连接错误:', err.message)
    })

    await redisClient.connect()
    console.log('[Redis] 连接成功')
    return redisClient
  } catch (error) {
    console.warn('[Redis] 连接失败，将使用内存缓存:', error)
    connectionFailed = true
    return null
  } finally {
    isConnecting = false
  }
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
  const redis = await getRedis()
  
  // 如果 Redis 不可用，直接调用 fetcher
  if (!redis) {
    return await fetcher()
  }
  
  try {
    // 尝试从缓存获取
    const cached = await redis.get(key)
    if (cached !== null) {
      return JSON.parse(cached) as T
    }
  } catch (error) {
    console.warn('[Redis] 获取缓存失败:', error)
    // 缓存失败时继续获取数据
  }

  // 缓存未命中，获取数据
  const data = await fetcher()

  try {
    // 缓存数据
    await redis.setEx(key, ttlSeconds, JSON.stringify(data))
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
    const redis = await getRedis()
    if (!redis) return
    await redis.setEx(key, ttlSeconds, JSON.stringify(data))
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
    const redis = await getRedis()
    if (!redis) return null
    const data = await redis.get(key)
    return data ? JSON.parse(data) as T : null
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
    const redis = await getRedis()
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
    const redis = await getRedis()
    if (!redis) return
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(keys)
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

