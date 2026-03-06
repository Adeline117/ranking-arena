/**
 * Next.js Edge Middleware — Global rate limiting + security headers
 * Runs on Vercel Edge for all matched routes (near-zero latency)
 */

import { NextResponse, type NextRequest } from 'next/server'

// Simple in-memory sliding window rate limiter for Edge Runtime
// Edge functions are stateless across invocations on different nodes,
// but within a single node this provides burst protection
const ipCounts = new Map<string, { count: number; resetAt: number }>()

function edgeRateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = ipCounts.get(ip)

  // Probabilistic cleanup (1% chance per request)
  if (Math.random() < 0.01) {
    for (const [k, v] of ipCounts) {
      if (v.resetAt < now) ipCounts.delete(k)
    }
  }

  if (!entry || entry.resetAt < now) {
    ipCounts.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }

  entry.count++
  return entry.count <= limit
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip rate limiting for cron jobs (authenticated by CRON_SECRET)
  if (pathname.startsWith('/api/cron/')) {
    return NextResponse.next()
  }

  // Skip static assets and internal Next.js routes
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/stickers/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next()
  }

  // Global rate limit for API routes: 300 requests per minute per IP
  if (pathname.startsWith('/api/')) {
    const forwarded = request.headers.get('x-forwarded-for')
    const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'

    if (!edgeRateLimit(ip, 300, 60_000)) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMIT_EXCEEDED' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        }
      )
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Match API routes (not static files)
    '/api/:path*',
  ],
}
