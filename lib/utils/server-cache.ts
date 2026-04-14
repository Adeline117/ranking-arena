/**
 * 服务端内存缓存工具
 * 用于 API 响应缓存，减少数据库查询
 * 
 * 注意：在 Serverless 环境中缓存可能会被重置，
 * 但仍然能显著减少同一实例内的重复查询
 */

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

// 全局缓存存储
const cacheStore = new Map<string, CacheEntry<unknown>>()

// Periodic cleanup of expired entries (prevents unbounded growth)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of cacheStore) {
      if (now - entry.timestamp > entry.ttl) {
        cacheStore.delete(key)
      }
    }
  }, 60_000).unref?.()
}

// 默认 TTL：5分钟
const DEFAULT_TTL = 5 * 60 * 1000

/**
 * 获取缓存数据
 */
export function getServerCache<T>(key: string): T | null {
  const entry = cacheStore.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  
  const now = Date.now()
  if (now - entry.timestamp > entry.ttl) {
    cacheStore.delete(key)
    return null
  }
  
  return entry.data
}

/**
 * 设置缓存数据
 */
export function setServerCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  cacheStore.set(key, {
    data,
    timestamp: Date.now(),
    ttl,
  })
}

/**
 * 删除缓存
 */
export function deleteServerCache(key: string): void {
  cacheStore.delete(key)
}

/**
 * 删除匹配前缀的所有缓存
 */
export function deleteServerCacheByPrefix(prefix: string): void {
  for (const key of cacheStore.keys()) {
    if (key.startsWith(prefix)) {
      cacheStore.delete(key)
    }
  }
}

/**
 * 清空所有缓存
 */
export function clearServerCache(): void {
  cacheStore.clear()
}

/**
 * 获取缓存统计信息
 */
export function getServerCacheStats(): { size: number; keys: string[] } {
  return {
    size: cacheStore.size,
    keys: Array.from(cacheStore.keys()),
  }
}

/**
 * 带缓存的异步函数包装器
 * 如果缓存命中，直接返回缓存数据
 * 否则执行函数并缓存结果
 */
export async function withCache<T>(
  key: string,
  fn: () => Promise<T>,
  ttl: number = DEFAULT_TTL
): Promise<T> {
  const cached = getServerCache<T>(key)
  if (cached !== null) {
    return cached
  }
  
  const result = await fn()
  setServerCache(key, result, ttl)
  return result
}

// 预定义的缓存 TTL
export const CacheTTL = {
  SHORT: 60 * 1000,        // 1分钟
  MEDIUM: 5 * 60 * 1000,   // 5分钟
  LONG: 15 * 60 * 1000,    // 15分钟
  HOUR: 60 * 60 * 1000,    // 1小时
} as const

