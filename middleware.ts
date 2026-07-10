/**
 * Edge middleware — coarse global per-IP rate-limit BACKSTOP for /api/*.
 *
 * WHY: per-route limits (lib/utils/rate-limit.ts) are opt-in and only ~139/311
 * API routes actually set one. That leaves a large surface an unauthenticated
 * attacker can machine-gun (spam, DB bloat) during airdrop traffic. This is a
 * global anti-hammer FLOOR, NOT a replacement for per-route limits — it is
 * deliberately generous (600 req/min/IP) so it never trips a legitimate user;
 * it only stops abusive hammering.
 *
 * Design guarantees:
 *  - FAIL-OPEN: no Redis env / Redis down / any error => request is ALLOWED.
 *    A rate-limit backstop must never be the thing that takes down the API.
 *  - Cron routes (/api/cron/*) are EXCLUDED — they carry `Authorization: Bearer
 *    CRON_SECRET` and run at high volume from Vercel's scheduler.
 *  - Static assets are never matched (matcher scopes to /api/*).
 *  - Edge-safe: @upstash/ratelimit + @upstash/redis are REST-based and run in
 *    the edge runtime.
 */

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const LIMIT = 600 // requests
const WINDOW = '60 s'

let ratelimit: Ratelimit | null = null
let initialized = false

function getRatelimit(): Ratelimit | null {
  if (initialized) return ratelimit
  initialized = true
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null // fail-open: no Redis configured (dev/preview)
  try {
    ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(LIMIT, WINDOW),
      prefix: 'mw:ipfloor',
      analytics: false,
    })
  } catch {
    ratelimit = null // fail-open
  }
  return ratelimit
}

function clientIp(req: NextRequest): string {
  // Trust only Vercel-set edge headers first (client-supplied XFF is stripped
  // by the edge). Generic XFF as fallback — same trust model as getIdentifier().
  const forwarded = req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl

  // Only guard the API surface; never the Bearer-authed cron routes.
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/cron/')) {
    return NextResponse.next()
  }

  const rl = getRatelimit()
  if (!rl) return NextResponse.next() // fail-open

  const ip = clientIp(req)
  if (ip === 'unknown') return NextResponse.next() // can't attribute → don't block

  try {
    const { success, limit, remaining, reset } = await rl.limit(`ip:${ip}`)
    if (!success) {
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: 'Too many requests',
          code: 'RATE_LIMIT_EXCEEDED',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': String(limit),
            'X-RateLimit-Remaining': String(remaining),
            'X-RateLimit-Reset': String(reset),
            'Retry-After': String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))),
          },
        }
      )
    }
  } catch {
    // fail-open: Redis error must never take down the API
    return NextResponse.next()
  }

  return NextResponse.next()
}

export const config = {
  // Scope to the API only — static assets, pages, and _next/* are untouched.
  matcher: ['/api/:path*'],
}
