/**
 * API 限流工具
 * 使用 Redis Cloud 实现分布式限流（滑动窗口算法）
 */

import { createClient, RedisClientType } from 'redis'
import { NextRequest, NextResponse } from 'next/server'

// Redis 客户端（限流专用）
let redis: RedisClientType | null = null
let isConnecting = false
let connectionFailed = false

async function getRedisForRateLimit(): Promise<RedisClientType | null> {
  // 如果已经连接失败，不再重试（避免每次请求都尝试连接）
  if (connectionFailed) {
    return null
  }

  if (redis && redis.isOpen) {
    return redis
  }

  // 防止并发连接
  if (isConnecting) {
    // 等待连接完成
    await new Promise(resolve => setTimeout(resolve, 100))
    return redis && redis.isOpen ? redis : null
  }

  const host = process.env.REDIS_HOST
  const port = process.env.REDIS_PORT
  const password = process.env.REDIS_PASSWORD
  const username = process.env.REDIS_USERNAME || 'default'

  if (!host || !password) {
    // 开发环境可能没有 Redis，静默跳过
    connectionFailed = true
    return null
  }

  isConnecting = true

  try {
    redis = createClient({
      username,
      password,
      socket: {
        host,
        port: parseInt(port || '6379', 10),
        reconnectStrategy: (retries) => {
          if (retries > 3) {
            connectionFailed = true
            return false // 停止重连
          }
          return Math.min(retries * 100, 1000)
        },
      },
    })

    redis.on('error', (err) => {
      console.error('[RateLimit] Redis 连接错误:', err.message)
    })

    await redis.connect()
    console.log('[RateLimit] Redis 连接成功')
    return redis
  } catch (error) {
    console.warn('[RateLimit] Redis 连接失败，限流功能已禁用:', error)
    connectionFailed = true
    return null
  } finally {
    isConnecting = false
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
}

// 默认限流配置
const defaultConfig: RateLimitConfig = {
  requests: 60,
  window: 60, // 每分钟 60 次
  prefix: 'api',
}

/**
 * 滑动窗口限流算法实现
 * 使用 Redis sorted set 实现精确的滑动窗口
 */
async function slidingWindowRateLimit(
  redis: RedisClientType,
  identifier: string,
  config: RateLimitConfig
): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
  const key = `ratelimit:${config.prefix}:${identifier}`
  const now = Date.now()
  const windowStart = now - config.window * 1000
  const windowEnd = now + config.window * 1000

  try {
    // 使用事务保证原子性
    const multi = redis.multi()
    
    // 1. 移除过期的请求记录
    multi.zRemRangeByScore(key, 0, windowStart)
    
    // 2. 添加当前请求
    multi.zAdd(key, { score: now, value: `${now}-${Math.random()}` })
    
    // 3. 获取窗口内的请求数
    multi.zCard(key)
    
    // 4. 设置键的过期时间
    multi.expire(key, config.window * 2)
    
    const results = await multi.exec()
    
    // results[2] 是 zCard 的结果
    const count = Number(results[2]) || 0
    const remaining = Math.max(0, config.requests - count)
    const success = count <= config.requests

    return {
      success,
      limit: config.requests,
      remaining,
      reset: windowEnd,
    }
  } catch (error) {
    console.error('[RateLimit] 限流检查出错:', error)
    // 出错时允许通过
    return {
      success: true,
      limit: config.requests,
      remaining: config.requests,
      reset: windowEnd,
    }
  }
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
    const redis = await getRedisForRateLimit()
    
    // Redis 不可用时，跳过限流检查（fail-open）
    if (!redis) {
      return null
    }

    const finalConfig = { ...defaultConfig, ...config }
    const identifier = getIdentifier(request, userId)
    
    const { success, limit, remaining, reset } = await slidingWindowRateLimit(
      redis,
      identifier,
      finalConfig
    )
    
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
 * 已优化以支持更高的用户并发
 */
export const RateLimitPresets = {
  // 公开 API - 宽松限制（提升至 150/分钟）
  public: { requests: 150, window: 60, prefix: 'public' } as RateLimitConfig,
  
  // 认证 API - 中等限制（提升至 300/分钟）
  authenticated: { requests: 300, window: 60, prefix: 'auth' } as RateLimitConfig,
  
  // 写操作 API - 适度限制（提升至 50/分钟）
  write: { requests: 50, window: 60, prefix: 'write' } as RateLimitConfig,
  
  // 读取 API - 高频限制（新增）
  read: { requests: 500, window: 60, prefix: 'read' } as RateLimitConfig,
  
  // 敏感操作 - 严格限制
  sensitive: { requests: 15, window: 60, prefix: 'sensitive' } as RateLimitConfig,
  
  // 登录/注册 - 防止暴力破解
  auth: { requests: 10, window: 60, prefix: 'login' } as RateLimitConfig,
  
  // 搜索 API - 中等限制（新增）
  search: { requests: 60, window: 60, prefix: 'search' } as RateLimitConfig,
  
  // WebSocket/实时连接 - 宽松限制（新增）
  realtime: { requests: 1000, window: 60, prefix: 'realtime' } as RateLimitConfig,
} as const

/**
 * 关闭 Redis 连接（用于优雅关闭）
 */
export async function closeRateLimitRedis(): Promise<void> {
  if (redis && redis.isOpen) {
    await redis.quit()
    redis = null
  }
}