/**
 * 工具函数统一导出
 */

export * from './date'
export * from './format'
export * from './logger'
export * from './redis'
export * from './rate-limit'
export * from './circuit-breaker'
export * from './provider-error'
export * from './validation'
export * from './content'
export * from './server-cache'
export * from './sanitize'
export * from './csrf'
// 注意：cache.ts 是客户端缓存，需要单独导入以避免命名冲突
// import { getCache, setCache } from '@/lib/utils/cache'

/**
 * 安全的 JSON 解析
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/**
 * 延迟函数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 防抖函数
 */
export function debounce<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  delay: number
): (...args: TArgs) => void {
  let timeoutId: NodeJS.Timeout | null = null
  
  return (...args: TArgs) => {
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => fn(...args), delay)
  }
}

/**
 * 节流函数
 */
export function throttle<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  limit: number
): (...args: TArgs) => void {
  let inThrottle = false
  
  return (...args: TArgs) => {
    if (!inThrottle) {
      fn(...args)
      inThrottle = true
      setTimeout(() => { inThrottle = false }, limit)
    }
  }
}

/**
 * 生成随机 ID
 */
export function generateId(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * 深拷贝对象
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  return JSON.parse(JSON.stringify(obj))
}

/**
 * 检查对象是否为空
 */
export function isEmpty(obj: unknown): boolean {
  if (obj === null || obj === undefined) return true
  if (typeof obj === 'string') return obj.trim().length === 0
  if (Array.isArray(obj)) return obj.length === 0
  if (typeof obj === 'object') return Object.keys(obj as object).length === 0
  return false
}

