/**
 * Redis Cloud 缓存工具
 * 用于分布式缓存，解决 Vercel 多实例缓存不共享问题
 * 
 * 注意：当 Redis 未配置时，将使用内存缓存作为后备方案
 */

// 内存缓存作为后备方案
const memoryCache = new Map<string, { data: string; expiry: number }>()

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
  // 尝试从内存缓存获取
  const cached = memoryCache.get(key)
  if (cached && cached.expiry > Date.now()) {
    try {
      return JSON.parse(cached.data) as T
    } catch {
      // 解析失败，继续获取新数据
    }
  }

  // 缓存未命中或已过期，获取数据
  const data = await fetcher()

    // 缓存数据
  try {
    memoryCache.set(key, {
      data: JSON.stringify(data),
      expiry: Date.now() + ttlSeconds * 1000,
    })
  } catch {
    // 缓存失败时忽略
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
    memoryCache.set(key, {
      data: JSON.stringify(data),
      expiry: Date.now() + ttlSeconds * 1000,
    })
  } catch {
    // 忽略缓存失败
  }
}

/**
 * 获取缓存
 * @param key 缓存键
 */
export async function getCache<T>(key: string): Promise<T | null> {
  const cached = memoryCache.get(key)
  if (cached && cached.expiry > Date.now()) {
    try {
      return JSON.parse(cached.data) as T
    } catch {
    return null
  }
  }
  return null
}

/**
 * 删除缓存
 * @param key 缓存键
 */
export async function deleteCache(key: string): Promise<void> {
  memoryCache.delete(key)
}

/**
 * 批量删除缓存（按前缀）
 * @param pattern 匹配模式，如 "traders:*"
 */
export async function deleteCacheByPattern(pattern: string): Promise<void> {
  const prefix = pattern.replace('*', '')
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key)
    }
  }
}

/**
 * 清理过期缓存
 */
export function cleanupExpiredCache(): void {
  const now = Date.now()
  for (const [key, value] of memoryCache.entries()) {
    if (value.expiry <= now) {
      memoryCache.delete(key)
    }
  }
}

// 定期清理过期缓存（每 5 分钟）
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupExpiredCache, 5 * 60 * 1000)
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
