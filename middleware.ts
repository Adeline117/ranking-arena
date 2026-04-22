import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Edge Middleware
 *
 * Handles non-ASCII path segments (Chinese, Korean, etc.) that cause 500
 * on Vercel's routing layer. Rewrites percent-encoded multi-byte UTF-8
 * paths to a normalized form that Vercel can route correctly.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Only intercept /trader/ and /u/ routes with percent-encoded non-ASCII chars
  // Pattern: %XX where XX > 7E (multi-byte UTF-8)
  if (
    (pathname.startsWith('/trader/') || pathname.startsWith('/u/')) &&
    /%[89A-Fa-f][0-9A-Fa-f]/.test(pathname)
  ) {
    // Rewrite to the same URL — this forces Next.js to handle
    // the routing internally rather than letting Vercel's edge
    // router reject it. The rewrite preserves the original URL
    // in the browser.
    const url = request.nextUrl.clone()
    return NextResponse.rewrite(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/trader/:path*', '/u/:path*'],
}
