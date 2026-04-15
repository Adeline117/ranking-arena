import { logger } from '@/lib/logger'
/**
 * 内存缓存回退机制
 * 当 Redis 不可用时提供本地内存缓存
 *
 * 特性:
 * - LRU 淘汰策略
 * - TTL 支持
 * - 条目数量限制
 * - 字节大小限制（防止内存溢出）
 * - 分区支持（不同类型数据独立管理）
 */

// ============================================
// Types
// ============================================

interface CacheEntry<T> {
  value: T
  expiresAt: number
  byteSize: number
}

interface MemoryCacheOptions {
  /** 最大条目数 */
  maxSize?: number
  /** 最大字节数 (默认 50MB) */
  maxBytes?: number
  /** 清理间隔 (ms) */
  cleanupIntervalMs?: number
  /** 缓存分区名称 (用于日志) */
  partition?: string
}

interface MemoryCacheStats {
  size: number
  maxSize: number
  byteSize: number
  maxBytes: number
  utilizationPercent: number
  bytesUtilizationPercent: number
}

// ============================================
// Byte Size Estimation
// ============================================

/**
 * Estimate the byte size of a JavaScript value
 * This is an approximation for memory management purposes
 */
function estimateByteSize(value: unknown): number {
  if (value === null || value === undefined) {
    return 8
  }

  const type = typeof value

  if (type === 'boolean') {
    return 4
  }

  if (type === 'number') {
    return 8
  }

  if (type === 'string') {
    // UTF-16 encoding: 2 bytes per character + overhead
    return (value as string).length * 2 + 40
  }

  if (type === 'object') {
    if (Array.isArray(value)) {
      // Array overhead + sum of elements
      let size = 40 // Array base overhead
      for (const item of value) {
        size += estimateByteSize(item) + 8 // 8 bytes for reference
      }
      return size
    }

    if (value instanceof Date) {
      return 48
    }

    if (value instanceof Map || value instanceof Set) {
      let size = 80 // Map/Set overhead
      if (value instanceof Map) {
        for (const [k, v] of value) {
          size += estimateByteSize(k) + estimateByteSize(v) + 16
        }
      } else {
        for (const item of value) {
          size += estimateByteSize(item) + 8
        }
      }
      return size
    }

    // Plain object
    let size = 40 // Object overhead
    for (const key of Object.keys(value as object)) {
      size += key.length * 2 + 32 // Key string + property overhead
      size += estimateByteSize((value as Record<string, unknown>)[key])
    }
    return size
  }

  // Default for unknown types
  return 64
}

// ============================================
// Memory Cache Class
// ============================================

export class MemoryCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map()
  private maxSize: number
  private maxBytes: number
  private currentBytes: number = 0
  private partition: string
  private cleanupInterval: NodeJS.Timeout | null = null

  // Statistics
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    byteEvictions: 0,
  }

  constructor(options: MemoryCacheOptions = {}) {
    this.maxSize = options.maxSize || 5000
    const defaultMaxBytes = parseInt(process.env.MEMORY_CACHE_MAX_BYTES || '', 10) || 50 * 1024 * 1024
    this.maxBytes = options.maxBytes || defaultMaxBytes // default 50 MB, configurable via MEMORY_CACHE_MAX_BYTES
    this.partition = options.partition || 'default'

    const cleanupIntervalMs = options.cleanupIntervalMs || 30000 // 30 seconds default

    // Start periodic cleanup
    if (typeof setInterval !== 'undefined') {
      this.cleanupInterval = setInterval(() => {
        this.cleanup()
      }, cleanupIntervalMs)
    }
  }

  /**
   * Get cached value
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined

    if (!entry) {
      this.stats.misses++
      return null
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.removeEntry(key, entry)
      this.stats.misses++
      return null
    }

    // LRU: delete and re-insert to update order
    this.cache.delete(key)
    this.cache.set(key, entry)

    this.stats.hits++
    return entry.value
  }

  /**
   * Set cached value with TTL
   */
  set<T>(key: string, value: T, ttlSeconds: number = 60): boolean {
    const byteSize = estimateByteSize(value)

    // Check if single entry exceeds max bytes (reject if too large)
    if (byteSize > this.maxBytes * 0.1) {
      // Single entry > 10% of max bytes
      logger.warn(
        `[MemoryCache:${this.partition}] Entry too large: ${key} (${formatBytes(byteSize)})`
      )
      return false
    }

    // Remove existing entry if present
    const existingEntry = this.cache.get(key)
    if (existingEntry) {
      this.currentBytes -= existingEntry.byteSize
      this.cache.delete(key)
    }

    // Evict entries if we're over byte limit
    while (this.currentBytes + byteSize > this.maxBytes && this.cache.size > 0) {
      this.evictOldest('bytes')
    }

    // Evict entries if we're over entry count limit
    while (this.cache.size >= this.maxSize) {
      this.evictOldest('count')
    }

    // Add new entry
    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
      byteSize,
    }

    this.cache.set(key, entry)
    this.currentBytes += byteSize

    return true
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key)
    if (entry) {
      this.removeEntry(key, entry)
      return true
    }
    return false
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    if (Date.now() > entry.expiresAt) {
      this.removeEntry(key, entry)
      return false
    }

    return true
  }

  /**
   * Delete entries by prefix
   */
  deleteByPrefix(prefix: string): number {
    let count = 0
    const keysToDelete: string[] = []

    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      const entry = this.cache.get(key)
      if (entry) {
        this.removeEntry(key, entry)
        count++
      }
    }

    return count
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now()
    let cleaned = 0
    const expiredKeys: string[] = []

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key)
      }
    }

    for (const key of expiredKeys) {
      const entry = this.cache.get(key)
      if (entry) {
        this.removeEntry(key, entry)
        cleaned++
      }
    }

    return cleaned
  }

  /**
   * Get cache statistics
   */
  getStats(): MemoryCacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      byteSize: this.currentBytes,
      maxBytes: this.maxBytes,
      utilizationPercent: Math.round((this.cache.size / this.maxSize) * 100),
      bytesUtilizationPercent: Math.round((this.currentBytes / this.maxBytes) * 100),
    }
  }

  /**
   * Get detailed statistics including hit/miss ratio
   */
  getDetailedStats(): MemoryCacheStats & {
    hits: number
    misses: number
    hitRate: number
    evictions: number
    byteEvictions: number
  } {
    const total = this.stats.hits + this.stats.misses
    return {
      ...this.getStats(),
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? Math.round((this.stats.hits / total) * 100) : 0,
      evictions: this.stats.evictions,
      byteEvictions: this.stats.byteEvictions,
    }
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear()
    this.currentBytes = 0
  }

  /**
   * Destroy the cache instance
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.cache.clear()
    this.currentBytes = 0
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Remove an entry and update byte count
   */
  private removeEntry(key: string, entry: CacheEntry<unknown>): void {
    this.cache.delete(key)
    this.currentBytes -= entry.byteSize
    if (this.currentBytes < 0) this.currentBytes = 0
  }

  /**
   * Evict the oldest entry (LRU)
   */
  private evictOldest(reason: 'count' | 'bytes'): void {
    const firstKey = this.cache.keys().next().value
    if (firstKey) {
      const entry = this.cache.get(firstKey)
      if (entry) {
        this.removeEntry(firstKey, entry)
        if (reason === 'bytes') {
          this.stats.byteEvictions++
        } else {
          this.stats.evictions++
        }
      }
    }
  }
}

// ============================================
// Helper Functions
// ============================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================
// Partitioned Cache Manager
// ============================================

/**
 * Manages multiple cache partitions for different data types
 * Each partition has independent size limits
 */
class PartitionedCacheManager {
  private partitions: Map<string, MemoryCache> = new Map()

  private defaultOptions: MemoryCacheOptions = {
    maxSize: 5000,
    maxBytes: 50 * 1024 * 1024,
    cleanupIntervalMs: 30000,
  }

  /**
   * Get or create a cache partition
   */
  getPartition(name: string, options?: Partial<MemoryCacheOptions>): MemoryCache {
    let cache = this.partitions.get(name)

    if (!cache) {
      cache = new MemoryCache({
        ...this.defaultOptions,
        ...options,
        partition: name,
      })
      this.partitions.set(name, cache)
    }

    return cache
  }

  /**
   * Get default partition
   */
  getDefault(): MemoryCache {
    return this.getPartition('default')
  }

  /**
   * Get rankings partition (optimized for large lists)
   */
  getRankings(): MemoryCache {
    return this.getPartition('rankings', {
      maxSize: 500,
      maxBytes: 30 * 1024 * 1024, // 30 MB for rankings
    })
  }

  /**
   * Get traders partition (optimized for trader details)
   */
  getTraders(): MemoryCache {
    return this.getPartition('traders', {
      maxSize: 1000,
      maxBytes: 20 * 1024 * 1024, // 20 MB for traders
    })
  }

  /**
   * Get all partition stats
   */
  getAllStats(): Record<string, MemoryCacheStats> {
    const stats: Record<string, MemoryCacheStats> = {}
    for (const [name, cache] of this.partitions) {
      stats[name] = cache.getStats()
    }
    return stats
  }

  /**
   * Clear all partitions
   */
  clearAll(): void {
    for (const cache of this.partitions.values()) {
      cache.clear()
    }
  }

  /**
   * Destroy all partitions
   */
  destroyAll(): void {
    for (const cache of this.partitions.values()) {
      cache.destroy()
    }
    this.partitions.clear()
  }
}

// ============================================
// Global Instances
// ============================================

// Legacy global memory cache (backward compatible)
let globalMemoryCache: MemoryCache | null = null

// New partitioned cache manager
let partitionedCacheManager: PartitionedCacheManager | null = null

/**
 * Get global memory cache instance (legacy API)
 */
export function getMemoryCache(): MemoryCache {
  if (!globalMemoryCache) {
    globalMemoryCache = new MemoryCache({
      maxSize: 5000,
      maxBytes: 50 * 1024 * 1024, // 50 MB
      cleanupIntervalMs: 30000,
      partition: 'global',
    })
  }
  return globalMemoryCache
}

/**
 * Get partitioned cache manager
 */
export function getPartitionedCache(): PartitionedCacheManager {
  if (!partitionedCacheManager) {
    partitionedCacheManager = new PartitionedCacheManager()
  }
  return partitionedCacheManager
}

/**
 * Reset global memory cache (for testing)
 */
export function resetMemoryCache(): void {
  if (globalMemoryCache) {
    globalMemoryCache.destroy()
    globalMemoryCache = null
  }
  if (partitionedCacheManager) {
    partitionedCacheManager.destroyAll()
    partitionedCacheManager = null
  }
}

// Export types
export type { MemoryCacheOptions, MemoryCacheStats }
