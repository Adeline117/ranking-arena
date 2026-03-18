/**
 * Next.js Edge Middleware
 *
 * Runs at the edge before every request. Handles:
 * - Security headers (X-Frame-Options, CSP, etc.)
 * - Bot protection for API routes
 * - Geo header for exchange routing
 *
 * Inspired by dub.co (23K★) and ixartz (12.7K★) middleware patterns.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Known bad bot patterns (scrapers, spam bots)
const BAD_BOT_PATTERNS = /bot[^a-z]|crawl|spider|scrape|headless|phantom|selenium|puppeteer|playwright|wget|curl\/[0-9]|python-requests|go-http|java\/|perl|ruby/i
// Good bots we allow (search engines, monitoring)
const GOOD_BOT_PATTERNS = /googlebot|bingbot|yandex|duckduck|baidu|facebookexternal|twitterbot|slurp|linkedinbot|vercel|uptime/i

export function middleware(request: NextRequest) {
  const response = NextResponse.next()

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.headers.set('X-DNS-Prefetch-Control', 'on')

  // Bot protection for API routes (not cron, not health)
  const path = request.nextUrl.pathname
  if (path.startsWith('/api/') && !path.startsWith('/api/cron/') && !path.startsWith('/api/health/')) {
    const ua = request.headers.get('user-agent') || ''

    // Block requests with no UA or very short UA (likely bots/scripts)
    if (!ua || ua.length < 10) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Block known bad bots, but allow good bots
    if (BAD_BOT_PATTERNS.test(ua) && !GOOD_BOT_PATTERNS.test(ua)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Geo header for exchange routing (Vercel provides geo via headers)
  const country = request.headers.get('x-vercel-ip-country') || ''
  if (country) {
    response.headers.set('X-User-Country', country)
  }

  return response
}

export const config = {
  matcher: [
    // Match all paths except static files and images
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|logo|og-image).*)',
  ],
}
