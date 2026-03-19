/**
 * API 限流工具
 * 使用 Upstash Redis 实现分布式限流（滑动窗口算法）
 */

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from './logger'

const rateLimitLogger = createLogger('RateLimit')

// Upstash Redis 客户端（限流专用）
let redis: Redis | null = null
let connectionFailed = false

function getUpstashRedis(): Redis | null {
  // 如果已经连接失败，不再重试
  if (connectionFailed) {
    return null
  }

  if (redis) {
    return redis
  }

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    // 开发环境可能没有 Redis，静默跳过
    connectionFailed = true
    return null
  }

  try {
    redis = new Redis({ url, token })
    rateLimitLogger.info('Upstash Redis 连接成功')
    return redis
  } catch (error) {
    rateLimitLogger.warn('Upstash Redis 连接失败，限流功能已禁用:', error)
    connectionFailed = true
    return null
  }
}

/**
 * 限流器配置
 */
export type RateLimitConfig = {
  /** 每个时间窗口允许的请求数 */
  requests: number
  /** 时间窗口（秒） */
  window: number
  /** 标识符前缀，用于区分不同的 API */
  prefix?: string
  /**
   * 当限流服务出错时的策略：
   * - false (默认): fail-open，允许请求通过
   * - true: fail-close，拒绝请求（返回 503）
   * 敏感操作（如登录、支付）应使用 failClose: true
   */
  failClose?: boolean
}

// 默认限流配置
const defaultConfig: RateLimitConfig = {
  requests: 60,
  window: 60, // 每分钟 60 次
  prefix: 'api',
}

// 缓存已创建的限流器实例
const rateLimiters = new Map<string, Ratelimit>()

/**
 * 获取或创建限流器实例
 */
function getRateLimiter(config: RateLimitConfig, redisClient: Redis): Ratelimit {
  const key = `${config.prefix}:${config.requests}:${config.window}`
  
  let limiter = rateLimiters.get(key)
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.slidingWindow(config.requests, `${config.window} s`),
      prefix: `ratelimit:${config.prefix}`,
      analytics: false, // 禁用分析以提高性能
    })
    rateLimiters.set(key, limiter)
  }
  
  return limiter
}

/**
 * 获取请求的标识符（IP 或用户 ID）
 */
export function getIdentifier(request: NextRequest, userId?: string): string {
  if (userId) {
    return `user:${userId}`
  }
  
  // 获取真实 IP
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() || 
             request.headers.get('x-real-ip') || 
             'unknown'
  
  return `ip:${ip}`
}

// 内存限流作为 Redis 不可用时的后备（简单的时间窗口计数）
const memoryRateLimits = new Map<string, { count: number; resetAt: number }>()

function checkMemoryRateLimit(
  identifier: string,
  config: RateLimitConfig
): { success: boolean; remaining: number; reset: number } {
  const now = Date.now()
  const key = `${config.prefix}:${identifier}`
  const entry = memoryRateLimits.get(key)

  // 清理过期条目（每100次检查清理一次）
  if (Math.random() < 0.01) {
    for (const [k, v] of memoryRateLimits.entries()) {
      if (v.resetAt < now) memoryRateLimits.delete(k)
    }
  }

  if (!entry || entry.resetAt < now) {
    // 新窗口
    const resetAt = now + config.window * 1000
    memoryRateLimits.set(key, { count: 1, resetAt })
    return { success: true, remaining: config.requests - 1, reset: resetAt }
  }

  if (entry.count >= config.requests) {
    return { success: false, remaining: 0, reset: entry.resetAt }
  }

  entry.count++
  return { success: true, remaining: config.requests - entry.count, reset: entry.resetAt }
}

/**
 * Rate limit check result — returned on success (null = blocked, object = allowed with metadata)
 */
export interface RateLimitResult {
  /** Response to return (non-null = 429 blocked) */
  response: NextResponse | null
  /** Rate limit metadata for injecting headers on allowed responses */
  meta: { limit: number; remaining: number; reset: number } | null
}

/**
 * 检查限流（完整版，带 meta 数据，供中间件使用）
 * @returns RateLimitResult with response (if blocked) and meta (for injecting headers on allowed responses)
 */
export async function checkRateLimitFull(
  request: NextRequest,
  config?: Partial<RateLimitConfig>,
  userId?: string
): Promise<RateLimitResult> {
  const finalConfig = { ...defaultConfig, ...config }
  const identifier = getIdentifier(request, userId)

  try {
    const redisClient = getUpstashRedis()

    // Redis 不可用时，使用内存限流作为后备（不再完全跳过）
    if (!redisClient) {
      const memResult = checkMemoryRateLimit(identifier, finalConfig)
      if (!memResult.success) {
        const retryAfter = Math.ceil((memResult.reset - Date.now()) / 1000)
        return {
          response: new NextResponse(
            JSON.stringify({
              success: false,
              error: '请求过于频繁，请稍后再试',
              code: 'RATE_LIMIT_EXCEEDED',
              retryAfter,
            }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'X-RateLimit-Limit': finalConfig.requests.toString(),
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': memResult.reset.toString(),
                'Retry-After': retryAfter.toString(),
              },
            }
          ),
          meta: null,
        }
      }
      return {
        response: null,
        meta: { limit: finalConfig.requests, remaining: memResult.remaining, reset: memResult.reset },
      }
    }

    const limiter = getRateLimiter(finalConfig, redisClient)
    const { success, limit, remaining, reset } = await limiter.limit(identifier)

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000)

      return {
        response: new NextResponse(
          JSON.stringify({
            success: false,
            error: '请求过于频繁，请稍后再试',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'X-RateLimit-Limit': limit.toString(),
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': reset.toString(),
              'Retry-After': retryAfter.toString(),
            },
          }
        ),
        meta: null,
      }
    }

    return {
      response: null,
      meta: { limit, remaining, reset },
    }
  } catch (error) {
    rateLimitLogger.error('限流检查失败:', error)

    // 敏感操作使用 fail-close 策略，拒绝请求
    if (finalConfig.failClose) {
      return {
        response: new NextResponse(
          JSON.stringify({
            success: false,
            error: '服务暂时不可用，请稍后再试',
            code: 'SERVICE_UNAVAILABLE',
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '30',
            },
          }
        ),
        meta: null,
      }
    }

    // 非敏感操作使用 fail-open 策略，允许请求通过
    return { response: null, meta: null }
  }
}

/**
 * 检查限流（向后兼容版本）
 * 直接返回 NextResponse | null，供不需要 meta 数据的路由使用。
 * null = 允许通过；NextResponse = 429 限流响应。
 *
 * @returns NextResponse (429) if rate-limited, null if allowed
 */
export async function checkRateLimit(
  request: NextRequest,
  config?: Partial<RateLimitConfig>,
  userId?: string
): Promise<NextResponse | null> {
  const result = await checkRateLimitFull(request, config, userId)
  return result.response
}

/**
 * 添加限流响应头
 */
export function addRateLimitHeaders(
  response: NextResponse,
  limit: number,
  remaining: number,
  reset: number
): NextResponse {
  response.headers.set('X-RateLimit-Limit', limit.toString())
  response.headers.set('X-RateLimit-Remaining', remaining.toString())
  response.headers.set('X-RateLimit-Reset', reset.toString())
  return response
}

/**
 * 预定义的限流配置
 * 已优化以支持更高的用户并发
 */
export const RateLimitPresets = {
  // 公开 API - 宽松限制（提升至 300/分钟，避免正常浏览触发 429）
  public: { requests: 300, window: 60, prefix: 'public' } as RateLimitConfig,

  // 认证 API - 中等限制（提升至 300/分钟）
  authenticated: { requests: 300, window: 60, prefix: 'auth' } as RateLimitConfig,

  // 写操作 API - 适度限制（提升至 50/分钟）
  write: { requests: 50, window: 60, prefix: 'write' } as RateLimitConfig,

  // 读取 API - 高频限制（排行榜/交易员数据等高频接口）
  read: { requests: 600, window: 60, prefix: 'read' } as RateLimitConfig,

  // 敏感操作 - 严格限制，fail-close
  sensitive: { requests: 15, window: 60, prefix: 'sensitive', failClose: true } as RateLimitConfig,

  // 登录/注册 - 防止暴力破解，fail-close
  auth: { requests: 10, window: 60, prefix: 'login', failClose: true } as RateLimitConfig,

  // 搜索 API - 中等限制（新增）
  search: { requests: 60, window: 60, prefix: 'search' } as RateLimitConfig,

  // WebSocket/实时连接 - 宽松限制（新增）
  realtime: { requests: 1000, window: 60, prefix: 'realtime' } as RateLimitConfig,
} as const

/**
 * 关闭 Redis 连接（用于优雅关闭）
 * 注意：Upstash Redis 使用 REST API，无需显式关闭连接
 */
export async function closeRateLimitRedis(): Promise<void> {
  // Upstash Redis 使用 HTTP REST API，无需关闭连接
  redis = null
  rateLimiters.clear()
}
