/**
 * API 限流工具
 * 使用 Upstash Redis 实现分布式限流
 */

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextRequest, NextResponse } from 'next/server'

// 创建 Redis 客户端（限流专用）
let redis: Redis | null = null

function getRedisForRateLimit(): Redis {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
      throw new Error('缺少 Upstash Redis 环境变量')
    }

    redis = new Redis({ url, token })
  }
  return redis
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
}

// 默认限流配置
const defaultConfig: RateLimitConfig = {
  requests: 60,
  window: 60, // 每分钟 60 次
  prefix: 'api',
}

// 缓存限流器实例
const rateLimiters = new Map<string, Ratelimit>()

/**
 * 获取或创建限流器
 */
function getRateLimiter(config: RateLimitConfig = defaultConfig): Ratelimit {
  const key = `${config.prefix}:${config.requests}:${config.window}`
  
  if (!rateLimiters.has(key)) {
    const limiter = new Ratelimit({
      redis: getRedisForRateLimit(),
      limiter: Ratelimit.slidingWindow(config.requests, `${config.window} s`),
      analytics: true,
      prefix: `ratelimit:${config.prefix}`,
    })
    rateLimiters.set(key, limiter)
  }
  
  return rateLimiters.get(key)!
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

/**
 * 检查限流
 * @returns 如果未超过限制返回 null，超过限制返回 429 响应
 */
export async function checkRateLimit(
  request: NextRequest,
  config?: Partial<RateLimitConfig>,
  userId?: string
): Promise<NextResponse | null> {
  try {
    const finalConfig = { ...defaultConfig, ...config }
    const limiter = getRateLimiter(finalConfig)
    const identifier = getIdentifier(request, userId)
    
    const { success, limit, remaining, reset } = await limiter.limit(identifier)
    
    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000)
      
      return new NextResponse(
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
      )
    }
    
    return null // 未超过限制
  } catch (error) {
    // 限流服务出错时，允许请求通过（fail-open）
    console.error('[RateLimit] 限流检查失败:', error)
    return null
  }
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
 */
export const RateLimitPresets = {
  // 公开 API - 宽松限制
  public: { requests: 100, window: 60, prefix: 'public' } as RateLimitConfig,
  
  // 认证 API - 中等限制
  authenticated: { requests: 200, window: 60, prefix: 'auth' } as RateLimitConfig,
  
  // 写操作 API - 严格限制
  write: { requests: 30, window: 60, prefix: 'write' } as RateLimitConfig,
  
  // 敏感操作 - 非常严格
  sensitive: { requests: 10, window: 60, prefix: 'sensitive' } as RateLimitConfig,
  
  // 登录/注册 - 防止暴力破解
  auth: { requests: 5, window: 60, prefix: 'login' } as RateLimitConfig,
} as const

