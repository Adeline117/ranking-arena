/**
 * 工具函数统一导出
 */

export * from './date'
export * from './format'
// Export from logger except withRetry (to avoid conflict with circuit-breaker)
export {
  logger,
  apiLogger,
  dataLogger,
  authLogger,
  perfLogger,
  exchangeLogger,
  realtimeLogger,
  uiLogger,
  Logger,
  createLogger,
  generateRequestId,
  setCurrentRequestId,
  getCurrentRequestId,
  clearCurrentRequestId,
  logRequest,
  createTimer,
  silent,
  logIf,
  devOnly,
  captureError,
  captureMessage,
  addBreadcrumb,
  safeExecute,
} from './logger'
export type { LogLevel, LoggerConfig, LogEntry } from './logger'

export * from './rate-limit'
// Export from circuit-breaker (includes withRetry)
export * from './circuit-breaker'
export * from './validation'
export * from './content'
export * from './server-cache'
// sanitize: import directly from '@/lib/utils/sanitize' — isomorphic-dompurify is heavy (~40KB)
// export * from './sanitize'
export * from './csrf'
export * from './currency'
// 缓存功能请使用 @/lib/cache

/**
 * 安全的 JSON 解析
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    // Intentionally swallowed: malformed JSON string, return provided fallback value
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

// ============================================
// Type Guards
// ============================================

/**
 * Type guard to check if value is an Error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error
}

/**
 * Safely extract Error from unknown catch value
 */
export function toError(value: unknown): Error {
  if (isError(value)) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String((value as { message: unknown }).message))
  }
  return new Error(String(value))
}

/**
 * Type guard to check if value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Type guard to check if value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Type guard to check if value is a finite number
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Safely get a property from an unknown object
 */
export function getProperty<T>(
  obj: unknown,
  key: string,
  validator?: (v: unknown) => v is T
): T | undefined {
  if (!isObject(obj)) return undefined
  const value = obj[key]
  if (validator) return validator(value) ? value : undefined
  return value as T | undefined
}

