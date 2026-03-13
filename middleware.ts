/**
 * Global Next.js Middleware
 *
 * Provides:
 * 1. Global rate limiting via Upstash Redis (coarse DDoS/abuse protection)
 * 2. Basic bot protection (empty User-Agent blocking)
 *
 * This is a global layer — individual API routes still apply their own
 * fine-grained rate limits (per user tier) via lib/utils/rate-limit.ts.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

// Lazy-init rate limiter (Edge Runtime compatible)
let ratelimit: Ratelimit | null = null

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(200, '1 m'),
    prefix: 'mw:rl',
    analytics: false,
  })
  return ratelimit
}

// Known search engine bots (case-insensitive substrings)
const ALLOWED_BOTS = [
  'googlebot', 'bingbot', 'yandexbot', 'duckduckbot', 'baiduspider',
  'slurp', 'facebot', 'twitterbot', 'linkedinbot', 'applebot',
  'uptimerobot', 'pingdom', 'vercel', 'github-actions',
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const ua = request.headers.get('user-agent') || ''

  // ── Skip cron routes (protected by CRON_SECRET, not IP-based) ──
  if (pathname.startsWith('/api/cron/') || pathname.startsWith('/api/scrape/')) {
    return NextResponse.next()
  }

  // ── Skip Stripe webhooks (verified by signature, not IP) ──
  if (pathname.startsWith('/api/stripe/webhook')) {
    return NextResponse.next()
  }

  // ── Skip health / monitoring endpoints ──
  if (pathname.startsWith('/api/health')) {
    return NextResponse.next()
  }

  // ── Bot protection: block empty UA on API routes ──
  if (pathname.startsWith('/api/') && !ua) {
    return new NextResponse(
      JSON.stringify({ error: 'Forbidden' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }

  // ── Allow known bots through without rate limiting ──
  const uaLower = ua.toLowerCase()
  const isKnownBot = ALLOWED_BOTS.some(bot => uaLower.includes(bot))
  if (isKnownBot) {
    return NextResponse.next()
  }

  // ── Rate limiting (API routes only) ──
  if (pathname.startsWith('/api/')) {
    const limiter = getRatelimit()
    if (limiter) {
      const forwarded = request.headers.get('x-forwarded-for')
      const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'

      try {
        const { success, limit, remaining, reset } = await limiter.limit(`mw:${ip}`)

        if (!success) {
          const retryAfter = Math.ceil((reset - Date.now()) / 1000)
          return new NextResponse(
            JSON.stringify({ error: 'Too many requests', retryAfter }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'X-RateLimit-Limit': String(limit),
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': String(reset),
                'Retry-After': String(retryAfter),
              },
            }
          )
        }

        // Attach rate limit headers to successful responses
        const response = NextResponse.next()
        response.headers.set('X-RateLimit-Limit', String(limit))
        response.headers.set('X-RateLimit-Remaining', String(remaining))
        return response
      } catch {
        // Fail-open: if Redis is down, allow the request through
        return NextResponse.next()
      }
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}
