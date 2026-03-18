/**
 * Next.js Edge Middleware
 *
 * Runs at the edge before every request. Handles:
 * - Security headers (helmetjs-inspired, 10.6K★)
 * - Bot protection for API routes
 * - Geo header for exchange routing
 * - Rate limit headers passthrough
 *
 * Sources: dub.co (23K★), ixartz (12.7K★), helmetjs (10.6K★)
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Known bad bot patterns (scrapers, spam bots)
const BAD_BOT_PATTERNS = /bot[^a-z]|crawl|spider|scrape|headless|phantom|selenium|puppeteer|playwright|wget|curl\/[0-9]|python-requests|go-http|java\/|perl|ruby/i
// Good bots we allow (search engines, monitoring, social previews)
const GOOD_BOT_PATTERNS = /googlebot|bingbot|yandex|duckduck|baidu|facebookexternal|twitterbot|slurp|linkedinbot|vercel|uptime|stripe|github|slack|telegram|discord|whatsapp/i

// CSP for pages (not API routes)
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://www.googletagmanager.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://*.upstash.io https://*.coingecko.com https://*.coinbase.com https://www.googletagmanager.com https://*.sentry.io",
  "frame-src https://js.stripe.com https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

export function middleware(request: NextRequest) {
  const response = NextResponse.next()
  const path = request.nextUrl.pathname

  // Security headers (helmetjs-inspired)
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.headers.set('X-DNS-Prefetch-Control', 'on')
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

  // CSP only on page routes (not API)
  if (!path.startsWith('/api/')) {
    response.headers.set('Content-Security-Policy', CSP_DIRECTIVES)
  }

  // Bot protection for public API routes (not cron, not health, not og)
  if (path.startsWith('/api/') && !path.startsWith('/api/cron/') && !path.startsWith('/api/health/') && !path.startsWith('/api/og/')) {
    const ua = request.headers.get('user-agent') || ''

    // Block requests with no UA or very short UA
    if (!ua || ua.length < 10) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Block known bad bots, but allow good bots
    if (BAD_BOT_PATTERNS.test(ua) && !GOOD_BOT_PATTERNS.test(ua)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Geo header for exchange routing
  const country = request.headers.get('x-vercel-ip-country') || ''
  if (country) {
    response.headers.set('X-User-Country', country)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|logo|og-image).*)',
  ],
}
