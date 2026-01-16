/**
 * 缓存管理
 * 提供客户端和服务端的缓存控制
 */

// ============================================
// 客户端简单缓存（兼容旧代码）
// ============================================

const clientCache = new Map<string, { data: unknown; timestamp: number }>()
const CLIENT_CACHE_TTL = 5 * 60 * 1000 // 5 分钟

/**
 * 获取客户端缓存
 */
export function getCache<T>(key: string): T | null {
  const entry = clientCache.get(key)
  if (!entry) return null
  
  // 检查是否过期
  if (Date.now() - entry.timestamp > CLIENT_CACHE_TTL) {
    clientCache.delete(key)
    return null
  }
  
  return entry.data as T
}

/**
 * 设置客户端缓存
 */
export function setCache<T>(key: string, data: T, ttl?: number): void {
  clientCache.set(key, {
    data,
    timestamp: Date.now(),
  })
  
  // 可选：设置自动清理
  if (ttl) {
    setTimeout(() => clientCache.delete(key), ttl)
  }
}

/**
 * 清除客户端缓存
 */
export function clearClientCache(): void {
  clientCache.clear()
}

// ============================================
// 类型定义
// ============================================

interface CacheEntry<T> {
  data: T
  createdAt: number
  expiresAt: number
  tags: string[]
}

interface CacheConfig {
  ttl: number           // 过期时间（毫秒）
  staleWhileRevalidate?: number // 允许返回过期数据的时间窗口
  tags?: string[]       // 缓存标签（用于批量失效）
}

// ============================================
// 缓存键前缀
// ============================================

export const CacheKeys = {
  // 交易员相关
  TRADERS_LIST: 'traders:list',
  TRADER_DETAIL: 'trader:detail',
  TRADER_PERFORMANCE: 'trader:performance',
  TRADER_STATS: 'trader:stats',
  SIMILAR_TRADERS: 'trader:similar',
  
  // 帖子相关
  POSTS_LIST: 'posts:list',
  POST_DETAIL: 'post:detail',
  POST_COMMENTS: 'post:comments',
  
  // 市场数据
  MARKET_DATA: 'market:data',
  MARKET_PRICES: 'market:prices',
  
  // 用户相关
  USER_PROFILE: 'user:profile',
  USER_FOLLOWING: 'user:following',
} as const

// ============================================
// 缓存标签
// ============================================

export const CacheTags = {
  TRADERS: 'traders',
  POSTS: 'posts',
  COMMENTS: 'comments',
  MARKET: 'market',
  USER: 'user',
} as const

// ============================================
// 默认 TTL 配置
// ============================================

export const DefaultTTL = {
  // 排行榜数据：5分钟（频繁更新）
  TRADERS_LIST: 5 * 60 * 1000,
  
  // 交易员详情：10分钟
  TRADER_DETAIL: 10 * 60 * 1000,
  
  // 帖子列表：2分钟
  POSTS_LIST: 2 * 60 * 1000,
  
  // 帖子详情：5分钟
  POST_DETAIL: 5 * 60 * 1000,
  
  // 市场数据：1分钟（实时性要求高）
  MARKET_DATA: 60 * 1000,
  
  // 用户资料：15分钟
  USER_PROFILE: 15 * 60 * 1000,
} as const

// ============================================
// 内存缓存实现
// ============================================

class MemoryCache {
  private cache = new Map<string, CacheEntry<unknown>>()
  private tagIndex = new Map<string, Set<string>>()

  /**
   * 获取缓存
   */
  get<T>(key: string): { data: T; isStale: boolean } | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    const now = Date.now()
    const isExpired = now > entry.expiresAt
    const isStale = isExpired && entry.createdAt + (entry.expiresAt - entry.createdAt) * 2 > now

    // 完全过期
    if (isExpired && !isStale) {
      this.delete(key)
      return null
    }

    return {
      data: entry.data as T,
      isStale,
    }
  }

  /**
   * 设置缓存
   */
  set<T>(key: string, data: T, config: CacheConfig): void {
    const now = Date.now()
    const entry: CacheEntry<T> = {
      data,
      createdAt: now,
      expiresAt: now + config.ttl,
      tags: config.tags || [],
    }

    this.cache.set(key, entry)

    // 更新标签索引
    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set())
      }
      this.tagIndex.get(tag)!.add(key)
    }
  }

  /**
   * 删除单个缓存
   */
  delete(key: string): void {
    const entry = this.cache.get(key)
    if (entry) {
      // 从标签索引中移除
      for (const tag of entry.tags) {
        this.tagIndex.get(tag)?.delete(key)
      }
    }
    this.cache.delete(key)
  }

  /**
   * 按标签失效
   */
  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag)
    if (!keys) return 0

    let count = 0
    for (const key of keys) {
      this.cache.delete(key)
      count++
    }
    this.tagIndex.delete(tag)

    console.log(`[Cache] Invalidated ${count} entries with tag: ${tag}`)
    return count
  }

  /**
   * 按前缀失效
   */
  invalidateByPrefix(prefix: string): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key)
        count++
      }
    }

    console.log(`[Cache] Invalidated ${count} entries with prefix: ${prefix}`)
    return count
  }

  /**
   * 按模式失效（正则）
   */
  invalidateByPattern(pattern: RegExp): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.delete(key)
        count++
      }
    }

    console.log(`[Cache] Invalidated ${count} entries matching pattern: ${pattern}`)
    return count
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
    this.tagIndex.clear()
    console.log('[Cache] Cleared all entries')
  }

  /**
   * 获取缓存统计
   */
  stats(): { size: number; tags: Record<string, number> } {
    const tags: Record<string, number> = {}
    for (const [tag, keys] of this.tagIndex.entries()) {
      tags[tag] = keys.size
    }

    return {
      size: this.cache.size,
      tags,
    }
  }
}

// 全局缓存实例
export const serverCache = new MemoryCache()

// ============================================
// 辅助函数
// ============================================

/**
 * 生成缓存键
 */
export function makeCacheKey(prefix: string, params: Record<string, unknown>): string {
  const sortedParams = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  return sortedParams ? `${prefix}:${sortedParams}` : prefix
}

/**
 * 带缓存的异步函数包装器
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  config: CacheConfig
): Promise<T> {
  // 尝试从缓存获取
  const cached = serverCache.get<T>(key)
  if (cached && !cached.isStale) {
    return cached.data
  }

  // Stale-while-revalidate: 返回旧数据，同时刷新
  if (cached?.isStale) {
    // 异步刷新
    fetcher().then(data => {
      serverCache.set(key, data, config)
    }).catch(err => {
      console.error(`[Cache] Failed to refresh ${key}:`, err)
    })
    return cached.data
  }

  // 获取新数据
  const data = await fetcher()
  serverCache.set(key, data, config)
  return data
}

// ============================================
// 缓存失效事件
// ============================================

type CacheInvalidationEvent = 
  | { type: 'trader_updated'; traderId: string }
  | { type: 'post_created'; authorId: string }
  | { type: 'post_deleted'; postId: string }
  | { type: 'comment_created'; postId: string }
  | { type: 'user_followed'; traderId: string }
  | { type: 'ranking_refresh' }

/**
 * 处理缓存失效事件
 */
export function handleCacheInvalidation(event: CacheInvalidationEvent): void {
  switch (event.type) {
    case 'trader_updated':
      // 失效单个交易员的缓存
      serverCache.invalidateByPattern(new RegExp(`trader:.*:${event.traderId}`))
      break

    case 'post_created':
    case 'post_deleted':
      // 失效帖子列表缓存
      serverCache.invalidateByPrefix(CacheKeys.POSTS_LIST)
      break

    case 'comment_created':
      // 失效帖子评论缓存
      serverCache.delete(`${CacheKeys.POST_COMMENTS}:${event.postId}`)
      break

    case 'user_followed':
      // 失效相似交易员推荐缓存
      serverCache.invalidateByPrefix(CacheKeys.SIMILAR_TRADERS)
      break

    case 'ranking_refresh':
      // 失效所有排行榜缓存
      serverCache.invalidateByTag(CacheTags.TRADERS)
      break
  }
}

// ============================================
// 导出
// ============================================

export {
  type CacheEntry,
  type CacheConfig,
  type CacheInvalidationEvent,
  MemoryCache,
}
