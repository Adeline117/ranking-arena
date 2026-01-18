/**
 * 内存缓存回退机制
 * 当 Redis 不可用时提供本地内存缓存
 * 
 * 特性:
 * - LRU 淘汰策略
 * - TTL 支持
 * - 容量限制
 */

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class MemoryCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map()
  private maxSize: number
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(options: { maxSize?: number; cleanupIntervalMs?: number } = {}) {
    this.maxSize = options.maxSize || 1000
    const cleanupIntervalMs = options.cleanupIntervalMs || 60000 // 默认 1 分钟清理一次

    // 启动定期清理过期条目
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => {
        this.cleanup()
      }, cleanupIntervalMs)
    }
  }

  /**
   * 获取缓存
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined
    
    if (!entry) {
      return null
    }

    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    // LRU: 删除并重新插入以更新顺序
    this.cache.delete(key)
    this.cache.set(key, entry)

    return entry.value
  }

  /**
   * 设置缓存
   */
  set<T>(key: string, value: T, ttlSeconds: number = 60): boolean {
    // 如果达到容量上限，删除最老的条目（Map 迭代顺序是插入顺序）
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })

    return true
  }

  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  /**
   * 检查是否存在
   */
  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }
    
    return true
  }

  /**
   * 按模式删除（简单前缀匹配）
   */
  deleteByPrefix(prefix: string): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    const now = Date.now()
    let cleaned = 0

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        cleaned++
      }
    }

    return cleaned
  }

  /**
   * 获取统计信息
   */
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
    }
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 销毁实例（清理定时器）
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.cache.clear()
  }
}

// 全局内存缓存实例
let globalMemoryCache: MemoryCache | null = null

/**
 * 获取全局内存缓存实例
 */
export function getMemoryCache(): MemoryCache {
  if (!globalMemoryCache) {
    globalMemoryCache = new MemoryCache({
      maxSize: 2000, // 最多缓存 2000 条
      cleanupIntervalMs: 30000, // 每 30 秒清理一次
    })
  }
  return globalMemoryCache
}

/**
 * 重置全局内存缓存（主要用于测试）
 */
export function resetMemoryCache(): void {
  if (globalMemoryCache) {
    globalMemoryCache.destroy()
    globalMemoryCache = null
  }
}
