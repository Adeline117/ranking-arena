/**
 * Next.js Edge Middleware
 *
 * Handles:
 * - Request logging (timestamp, path, status code)
 * - Rate limiting via Upstash
 * - Auth token validation for protected routes
 */

import { NextRequest, NextResponse } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { createClient } from '@supabase/supabase-js'

// ─── Public paths (no auth required) ───────────────────────────────

const PUBLIC_EXACT_PATHS = new Set([
  '/',
  '/login',
  '/rankings',
  '/library',
  '/flash-news',
  '/search',
  '/hot',
])

const PUBLIC_PREFIX_PATHS = [
  '/api/v2/rankings',
  '/api/flash-news',
  '/api/search',
  '/api/rankings',
  '/api/traders',
  '/api/library',
  '/api/stats',
  '/api/avatar',
  '/api/health',
  '/api/monitoring',
  '/api/cron/',
  '/api/webhook/',
  '/api/auth/',
  '/trader/',
  '/exchange/',
  '/market/',
  '/(legal)/',
  '/_next/',
  '/favicon',
  '/public/',
]

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true
  return PUBLIC_PREFIX_PATHS.some((prefix) => pathname.startsWith(prefix))
}

// ─── Rate limiter (lazy init) ───────────────────────────────────────

let ratelimit: Ratelimit | null = null

function getRatelimit(): Ratelimit | null {
  if (ratelimit) return ratelimit
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null

  ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(120, '60s'),
    prefix: 'middleware:rl',
    analytics: false,
  })
  return ratelimit
}

// ─── Auth validation ────────────────────────────────────────────────

async function validateToken(token: string): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseServiceKey) return false

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error } = await supabase.auth.getUser(token)
    return !error && !!user
  } catch {
    return false
  }
}

// ─── Middleware ─────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const start = Date.now()
  const { pathname } = request.nextUrl
  const method = request.method

  // --- Rate limiting for API routes ---
  if (pathname.startsWith('/api/')) {
    const rl = getRatelimit()
    if (rl) {
      // Use IP as identifier, fall back to 'anonymous'
      const ip =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        'anonymous'

      try {
        const { success, limit, remaining, reset } = await rl.limit(ip)
        if (!success) {
          const retryAfter = Math.ceil((reset - Date.now()) / 1000)
          console.warn(`[middleware] ${method} ${pathname} 429 rate-limited ip=${ip} +${Date.now() - start}ms`)
          return new NextResponse('Too Many Requests', {
            status: 429,
            headers: {
              'Retry-After': String(retryAfter),
              'X-RateLimit-Limit': String(limit),
              'X-RateLimit-Remaining': String(remaining),
              'X-RateLimit-Reset': String(reset),
            },
          })
        }
      } catch {
        // Rate limit errors are non-fatal — allow request through
      }
    }
  }

  // --- Auth check for protected routes ---
  const needsAuth = !isPublicPath(pathname) && pathname.startsWith('/api/')

  if (needsAuth) {
    const authHeader = request.headers.get('authorization')
    const match = authHeader?.match(/^Bearer\s+(\S+)$/i)
    const token = match?.[1]

    if (!token) {
      console.warn(`[middleware] ${method} ${pathname} 401 missing-token +${Date.now() - start}ms`)
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const valid = await validateToken(token)
    if (!valid) {
      console.warn(`[middleware] ${method} ${pathname} 401 invalid-token +${Date.now() - start}ms`)
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  // --- Pass through + log ---
  const response = NextResponse.next()

  // Log after response is forwarded (debug only - omit in production to reduce noise)
  const duration = Date.now() - start
  if (process.env.NODE_ENV === 'development') {
    console.warn(`[middleware] ${method} ${pathname} -> +${duration}ms`)
  }

  return response
}

// ─── Matcher config ─────────────────────────────────────────────────

export const config = {
  matcher: [
    // Match all paths except static assets, images, and _next internals
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
