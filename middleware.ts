/**
 * Next.js Edge Middleware — Global API Rate Limiting
 *
 * Applies tiered rate limits to all /api/* routes using Upstash Redis
 * sliding window. Falls back to in-memory limiting when Redis is unavailable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const config = {
  matcher: '/api/:path*',
}

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

type Tier = {
  requests: number
  window: `${number} ${'s' | 'm' | 'h'}`
  prefix: string
}

const TIERS = {
  health:   { requests: 200, window: '60 s', prefix: 'rl:health' },
  admin:    { requests: 60,  window: '60 s', prefix: 'rl:admin' },
  auth:     { requests: 10,  window: '60 s', prefix: 'rl:auth' },
  upload:   { requests: 20,  window: '60 s', prefix: 'rl:upload' },
  readGet:  { requests: 120, window: '60 s', prefix: 'rl:get' },
  writeMut: { requests: 30,  window: '60 s', prefix: 'rl:mut' },
} as const satisfies Record<string, Tier>

// ---------------------------------------------------------------------------
// Upstash rate limiters (lazy-initialised singletons)
// ---------------------------------------------------------------------------

let redis: Redis | null = null
let redisUnavailable = false
const limiters = new Map<string, Ratelimit>()

function getRedis(): Redis | null {
  if (redisUnavailable) return null
  if (redis) return redis

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    redisUnavailable = true
    return null
  }

  try {
    redis = new Redis({ url, token })
    return redis
  } catch {
    redisUnavailable = true
    return null
  }
}

function getLimiter(tier: Tier): Ratelimit | null {
  const r = getRedis()
  if (!r) return null

  let lim = limiters.get(tier.prefix)
  if (!lim) {
    lim = new Ratelimit({
      redis: r,
      limiter: Ratelimit.slidingWindow(tier.requests, tier.window),
      prefix: tier.prefix,
      analytics: false,
    })
    limiters.set(tier.prefix, lim)
  }
  return lim
}

// ---------------------------------------------------------------------------
// In-memory fallback (simple fixed-window counter)
// ---------------------------------------------------------------------------

const memStore = new Map<string, { count: number; resetAt: number }>()

function memCheck(
  key: string,
  max: number,
  windowMs: number,
): { success: boolean; remaining: number; resetAt: number } {
  const now = Date.now()

  // Probabilistic cleanup
  if (Math.random() < 0.005) {
    for (const [k, v] of memStore) {
      if (v.resetAt < now) memStore.delete(k)
    }
  }

  const entry = memStore.get(key)
  if (!entry || entry.resetAt < now) {
    const resetAt = now + windowMs
    memStore.set(key, { count: 1, resetAt })
    return { success: true, remaining: max - 1, resetAt }
  }

  entry.count++
  if (entry.count > max) {
    return { success: false, remaining: 0, resetAt: entry.resetAt }
  }
  return { success: true, remaining: max - entry.count, resetAt: entry.resetAt }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? '127.0.0.1'
}

function build429(limit: number, remaining: number, resetAt: number): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
  return new NextResponse(
    JSON.stringify({
      success: false,
      error: 'Too many requests. Please try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'RateLimit-Limit': String(limit),
        'RateLimit-Remaining': String(remaining),
        'RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
      },
    },
  )
}

// ---------------------------------------------------------------------------
// Route → Tier classification
// ---------------------------------------------------------------------------

function classifyRoute(pathname: string, method: string): Tier | null {
  // Skip — internal / webhook / payment callbacks
  if (
    pathname.startsWith('/api/cron/') ||
    pathname.startsWith('/api/webhook/') ||
    pathname.startsWith('/api/stripe/')
  ) {
    return null
  }

  if (pathname.startsWith('/api/health')) return TIERS.health
  if (pathname.startsWith('/api/admin/')) return TIERS.admin

  // Auth & 2FA — strict
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/settings/2fa/')) {
    return TIERS.auth
  }

  // Uploads
  if (
    pathname.startsWith('/api/posts/upload') ||
    pathname.startsWith('/api/chat/upload') ||
    pathname.startsWith('/api/avatar/')
  ) {
    return TIERS.upload
  }

  // Default: split by method
  return method === 'GET' ? TIERS.readGet : TIERS.writeMut
}

// ---------------------------------------------------------------------------
// Middleware entry point
// ---------------------------------------------------------------------------

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const method = request.method

  const tier = classifyRoute(pathname, method)
  if (!tier) return NextResponse.next()

  const ip = getClientIp(request)
  // For admin tier, use cookie-based identifier if available
  const identifier =
    tier === TIERS.admin
      ? request.cookies.get('next-auth.session-token')?.value ?? ip
      : ip

  const key = `${tier.prefix}:${identifier}`

  // Try Upstash first
  const limiter = getLimiter(tier)
  if (limiter) {
    try {
      const { success, limit, remaining, reset } = await limiter.limit(key)
      if (!success) {
        return build429(limit, remaining, reset)
      }
      // Attach headers to successful responses
      const res = NextResponse.next()
      res.headers.set('X-RateLimit-Limit', String(limit))
      res.headers.set('X-RateLimit-Remaining', String(remaining))
      res.headers.set('X-RateLimit-Reset', String(Math.ceil(reset / 1000)))
      return res
    } catch {
      // Redis error — fall through to memory fallback
    }
  }

  // Memory fallback
  const windowMs = parseInt(tier.window) * 1000
  const result = memCheck(key, tier.requests, windowMs)
  if (!result.success) {
    return build429(tier.requests, 0, result.resetAt)
  }

  const res = NextResponse.next()
  res.headers.set('X-RateLimit-Limit', String(tier.requests))
  res.headers.set('X-RateLimit-Remaining', String(result.remaining))
  res.headers.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
  return res
}
