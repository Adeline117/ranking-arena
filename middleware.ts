import { NextResponse, type NextRequest } from 'next/server'

/**
 * Simple in-memory IP-based rate limiting for API routes.
 * 60 requests per minute per IP.
 * Note: This resets on cold starts. For production, consider Redis-based limiting.
 */

const WINDOW_MS = 60 * 1000 // 1 minute
const MAX_REQUESTS = 60

// Map<ip, { count, resetTime }>
const rateLimitMap = new Map<string, { count: number; resetTime: number }>()

// Periodic cleanup to prevent memory leak
let lastCleanup = Date.now()
function cleanup() {
  const now = Date.now()
  if (now - lastCleanup < WINDOW_MS) return
  lastCleanup = now
  for (const [key, val] of rateLimitMap) {
    if (now > val.resetTime) rateLimitMap.delete(key)
  }
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetTime: number } {
  cleanup()
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now > entry.resetTime) {
    const resetTime = now + WINDOW_MS
    rateLimitMap.set(ip, { count: 1, resetTime })
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetTime }
  }

  entry.count++
  if (entry.count > MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetTime: entry.resetTime }
  }

  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetTime: entry.resetTime }
}

export function middleware(request: NextRequest) {
  // Only rate-limit API routes
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // Skip health check
  if (request.nextUrl.pathname === '/api/health') {
    return NextResponse.next()
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'

  const { allowed, remaining, resetTime } = checkRateLimit(ip)

  if (!allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((resetTime - Date.now()) / 1000)),
          'X-RateLimit-Limit': String(MAX_REQUESTS),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(resetTime / 1000)),
        },
      }
    )
  }

  const response = NextResponse.next()
  response.headers.set('X-RateLimit-Limit', String(MAX_REQUESTS))
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  response.headers.set('X-RateLimit-Reset', String(Math.ceil(resetTime / 1000)))
  return response
}

export const config = {
  matcher: '/api/:path*',
}
