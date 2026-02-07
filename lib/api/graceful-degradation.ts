/**
 * Graceful Degradation for Exchange API Errors
 * 
 * 当交易所返回 502/503 时，优雅地处理并安抚用户
 */

import { createLogger } from '@/lib/utils/logger'
import { formatError } from '@/lib/errors/user-friendly-errors'

const logger = createLogger('GracefulDegradation')

// ===== 类型定义 =====

export interface ExchangeStatus {
  platform: string
  status: 'online' | 'degraded' | 'offline' | 'maintenance'
  lastSuccess: Date | null
  lastError: Date | null
  errorCount: number
  message?: string
}

export interface FallbackData<T> {
  data: T
  source: 'live' | 'cache' | 'fallback'
  staleSeconds?: number
  message?: string
}

export interface GracefulResponse<T> {
  success: boolean
  data?: T
  fallback?: FallbackData<T>
  error?: {
    code: string
    message: string
    messageZh: string
    retryAfterMs?: number
  }
  exchangeStatus?: ExchangeStatus
}

// ===== 交易所状态管理 =====

class ExchangeStatusManager {
  private statuses = new Map<string, ExchangeStatus>()
  private cache = new Map<string, { data: unknown; timestamp: number }>()
  private readonly cacheMaxAge = 5 * 60 * 1000 // 5 minutes

  getStatus(platform: string): ExchangeStatus {
    return this.statuses.get(platform) || {
      platform,
      status: 'online',
      lastSuccess: null,
      lastError: null,
      errorCount: 0,
    }
  }

  recordSuccess(platform: string): void {
    const current = this.getStatus(platform)
    this.statuses.set(platform, {
      ...current,
      status: 'online',
      lastSuccess: new Date(),
      errorCount: 0,
    })
  }

  recordError(platform: string, statusCode: number, message?: string): ExchangeStatus {
    const current = this.getStatus(platform)
    const errorCount = current.errorCount + 1
    
    let status: ExchangeStatus['status'] = 'degraded'
    if (statusCode === 502 || statusCode === 503) {
      status = 'maintenance'
    } else if (errorCount >= 5) {
      status = 'offline'
    }

    const updated: ExchangeStatus = {
      ...current,
      status,
      lastError: new Date(),
      errorCount,
      message,
    }
    
    this.statuses.set(platform, updated)
    logger.warn(`Exchange ${platform} status: ${status} (${errorCount} errors)`, { statusCode, message })
    
    return updated
  }

  // 缓存管理
  setCache<T>(key: string, data: T): void {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  getCache<T>(key: string): { data: T; staleSeconds: number } | null {
    const cached = this.cache.get(key)
    if (!cached) return null
    
    const staleSeconds = Math.floor((Date.now() - cached.timestamp) / 1000)
    if (staleSeconds > this.cacheMaxAge / 1000) {
      this.cache.delete(key)
      return null
    }
    
    return { data: cached.data as T, staleSeconds }
  }

  getAllStatuses(): ExchangeStatus[] {
    return Array.from(this.statuses.values())
  }
}

export const exchangeStatusManager = new ExchangeStatusManager()

// ===== 优雅降级包装器 =====

/**
 * 包装 API 调用，提供优雅降级
 */
export async function withGracefulDegradation<T>(
  platform: string,
  cacheKey: string,
  fetcher: () => Promise<T>,
  options: {
    fallbackData?: T
    maxRetries?: number
    retryDelayMs?: number
    language?: 'en' | 'zh'
  } = {}
): Promise<GracefulResponse<T>> {
  const { fallbackData, maxRetries = 2, retryDelayMs = 1000, language = 'en' } = options

  let lastError: unknown
  
  // 尝试获取实时数据
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await fetcher()
      
      // 成功：更新状态和缓存
      exchangeStatusManager.recordSuccess(platform)
      exchangeStatusManager.setCache(cacheKey, data)
      
      return {
        success: true,
        data,
        exchangeStatus: exchangeStatusManager.getStatus(platform),
      }
    } catch (error) {
      lastError = error
      
      // 记录错误
      const statusCode = extractStatusCode(error)
      exchangeStatusManager.recordError(platform, statusCode, String(error))
      
      // 是否需要重试
      if (attempt < maxRetries && shouldRetry(statusCode)) {
        await delay(retryDelayMs * Math.pow(2, attempt))
        continue
      }
      
      break
    }
  }

  // 获取失败，尝试缓存
  const cached = exchangeStatusManager.getCache<T>(cacheKey)
  if (cached) {
    const friendlyError = formatError(lastError, language)
    
    return {
      success: true, // 有缓存数据算成功
      fallback: {
        data: cached.data,
        source: 'cache',
        staleSeconds: cached.staleSeconds,
        message: language === 'zh' 
          ? `显示 ${cached.staleSeconds} 秒前的缓存数据` 
          : `Showing cached data from ${cached.staleSeconds}s ago`,
      },
      error: {
        code: friendlyError.icon,
        message: friendlyError.message,
        messageZh: friendlyError.message,
        retryAfterMs: friendlyError.retryAfterMs,
      },
      exchangeStatus: exchangeStatusManager.getStatus(platform),
    }
  }

  // 无缓存，使用回退数据
  if (fallbackData) {
    const friendlyError = formatError(lastError, language)
    
    return {
      success: true,
      fallback: {
        data: fallbackData,
        source: 'fallback',
        message: language === 'zh' 
          ? '显示默认数据' 
          : 'Showing default data',
      },
      error: {
        code: friendlyError.icon,
        message: friendlyError.message,
        messageZh: friendlyError.message,
        retryAfterMs: friendlyError.retryAfterMs,
      },
      exchangeStatus: exchangeStatusManager.getStatus(platform),
    }
  }

  // 完全失败
  const friendlyError = formatError(lastError, language)
  
  return {
    success: false,
    error: {
      code: friendlyError.icon,
      message: friendlyError.message,
      messageZh: friendlyError.message,
      retryAfterMs: friendlyError.retryAfterMs,
    },
    exchangeStatus: exchangeStatusManager.getStatus(platform),
  }
}

// ===== 辅助函数 =====

function extractStatusCode(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    if (typeof obj.status === 'number') return obj.status
    if (typeof obj.statusCode === 'number') return obj.statusCode
  }
  return 500
}

function shouldRetry(statusCode: number): boolean {
  // 429, 502, 503, 504 应该重试
  return [429, 502, 503, 504].includes(statusCode)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ===== 前端 Hook =====

/**
 * 生成用户友好的错误提示组件 props
 */
export function getExchangeErrorProps(
  status: ExchangeStatus | undefined,
  language: 'en' | 'zh' = 'en'
): {
  show: boolean
  icon: string
  title: string
  message: string
  action?: { label: string; onClick: () => void }
} | null {
  if (!status || status.status === 'online') {
    return null
  }

  const isZh = language === 'zh'

  switch (status.status) {
    case 'maintenance':
      return {
        show: true,
        icon: '[MAINT]',
        title: isZh ? '交易所维护中' : 'Exchange Maintenance',
        message: isZh 
          ? `${status.platform} 正在进行临时维护，数据将在维护结束后更新。`
          : `${status.platform} is under temporary maintenance. Data will update when complete.`,
      }
    
    case 'degraded':
      return {
        show: true,
        icon: '[WARN]',
        title: isZh ? '数据延迟' : 'Data Delayed',
        message: isZh
          ? `${status.platform} 响应缓慢，当前显示缓存数据。`
          : `${status.platform} is responding slowly. Showing cached data.`,
      }
    
    case 'offline':
      return {
        show: true,
        icon: '[ERROR]',
        title: isZh ? '交易所离线' : 'Exchange Offline',
        message: isZh
          ? `${status.platform} 暂时无法访问，请稍后重试。`
          : `${status.platform} is temporarily unavailable. Please try again later.`,
        action: {
          label: isZh ? '重试' : 'Retry',
          onClick: () => window.location.reload(),
        },
      }
    
    default:
      return null
  }
}

export default {
  withGracefulDegradation,
  exchangeStatusManager,
  getExchangeErrorProps,
}
