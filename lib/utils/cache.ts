/**
 * 客户端缓存工具
 * 使用 localStorage 缓存API响应数据
 */

const CACHE_PREFIX = 'arena_cache_'
const DEFAULT_TTL = 5 * 60 * 1000 // 5分钟

interface CacheItem<T> {
  data: T
  timestamp: number
  ttl: number
}

/**
 * 获取缓存数据
 */
export function getCache<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  
  try {
    const itemStr = localStorage.getItem(`${CACHE_PREFIX}${key}`)
    if (!itemStr) return null
    
    const item: CacheItem<T> = JSON.parse(itemStr)
    const now = Date.now()
    
    // 检查是否过期
    if (now - item.timestamp > item.ttl) {
      localStorage.removeItem(`${CACHE_PREFIX}${key}`)
      return null
    }
    
    return item.data
  } catch (error) {
    console.error('[Cache] 读取缓存失败:', error)
    return null
  }
}

/**
 * 设置缓存数据
 */
export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  if (typeof window === 'undefined') return
  
  try {
    const item: CacheItem<T> = {
      data,
      timestamp: Date.now(),
      ttl,
    }
    localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(item))
  } catch (error) {
    console.error('[Cache] 写入缓存失败:', error)
    // 如果存储空间不足，清理旧缓存
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      clearExpiredCache()
      try {
        localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify({
          data,
          timestamp: Date.now(),
          ttl,
        }))
      } catch (retryError) {
        console.error('[Cache] 重试写入缓存失败:', retryError)
      }
    }
  }
}

/**
 * 删除缓存
 */
export function removeCache(key: string): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(`${CACHE_PREFIX}${key}`)
}

/**
 * 清理过期缓存
 */
export function clearExpiredCache(): void {
  if (typeof window === 'undefined') return
  
  try {
    const keys = Object.keys(localStorage)
    const now = Date.now()
    
    keys.forEach((key) => {
      if (key.startsWith(CACHE_PREFIX)) {
        try {
          const itemStr = localStorage.getItem(key)
          if (itemStr) {
            const item: CacheItem<any> = JSON.parse(itemStr)
            if (now - item.timestamp > item.ttl) {
              localStorage.removeItem(key)
            }
          }
        } catch {
          // 如果解析失败，删除该项
          localStorage.removeItem(key)
        }
      }
    })
  } catch (error) {
    console.error('[Cache] 清理过期缓存失败:', error)
  }
}

/**
 * 清空所有缓存
 */
export function clearAllCache(): void {
  if (typeof window === 'undefined') return
  
  try {
    const keys = Object.keys(localStorage)
    keys.forEach((key) => {
      if (key.startsWith(CACHE_PREFIX)) {
        localStorage.removeItem(key)
      }
    })
  } catch (error) {
    console.error('[Cache] 清空所有缓存失败:', error)
  }
}

