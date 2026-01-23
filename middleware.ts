/**
 * Next.js Edge Middleware
 * 统一 API 限流保护 - 对所有公开 API 路由应用 Upstash Redis 限流
 */

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Edge-compatible Upstash Redis 限流器（延迟初始化）
let ratelimit: Ratelimit | null = null

function getRateLimiter(): Ratelimit | null {
  if (ratelimit) return ratelimit

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) return null

  try {
    ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(120, '60 s'), // 120 请求/分钟
      prefix: 'mw:ratelimit',
      analytics: false,
    })
    return ratelimit
  } catch {
    return null
  }
}

// 写操作限流器（更严格）
let writeRatelimit: Ratelimit | null = null

function getWriteRateLimiter(): Ratelimit | null {
  if (writeRatelimit) return writeRatelimit

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) return null

  try {
    writeRatelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(30, '60 s'), // 30 请求/分钟
      prefix: 'mw:ratelimit:write',
      analytics: false,
    })
    return writeRatelimit
  } catch {
    return null
  }
}

// 写操作路由（POST/PUT/DELETE 需要更严格限流）
const WRITE_PATHS = [
  '/api/posts',
  '/api/comments',
  '/api/trader-alerts',
  '/api/saved-filters',
  '/api/avoid-list',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 只对 API 路由应用限流
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // 跳过健康检查和 cron 端点
  if (pathname === '/api/health' || pathname.startsWith('/api/cron')) {
    return NextResponse.next()
  }

  // 获取客户端 IP
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'anonymous'

  // 判断是否为写操作
  const isWriteMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)
  const isWritePath = WRITE_PATHS.some(p => pathname.startsWith(p))
  const useWriteLimit = isWriteMethod && isWritePath

  const limiter = useWriteLimit ? getWriteRateLimiter() : getRateLimiter()

  // Redis 不可用时放行（fail-open）
  if (!limiter) {
    return NextResponse.next()
  }

  try {
    const { success, limit, remaining, reset } = await limiter.limit(ip)

    const response = success
      ? NextResponse.next()
      : NextResponse.json(
          { success: false, error: '请求过于频繁，请稍后再试', code: 'RATE_LIMIT_EXCEEDED' },
          { status: 429 }
        )

    // 添加限流信息头
    response.headers.set('X-RateLimit-Limit', limit.toString())
    response.headers.set('X-RateLimit-Remaining', remaining.toString())
    response.headers.set('X-RateLimit-Reset', reset.toString())

    return response
  } catch {
    // 限流检查失败时放行
    return NextResponse.next()
  }
}

export const config = {
  matcher: '/api/:path*',
}
