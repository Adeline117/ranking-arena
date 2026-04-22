import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Edge Middleware
 *
 * Fixes: Vercel's routing layer returns 500 for dynamic routes with
 * non-ASCII path segments (Chinese, Korean, etc.). The percent-encoded
 * multi-byte UTF-8 paths fail to match /trader/[handle] and /u/[handle].
 *
 * Solution: Intercept these requests and rewrite them, forcing Next.js
 * to handle routing internally.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Only act on /trader/ and /u/ routes containing percent-encoded
  // multi-byte UTF-8 characters (bytes 0x80+)
  if (
    (pathname.startsWith('/trader/') || pathname.startsWith('/u/')) &&
    /%[89A-Fa-f][0-9A-Fa-f]/.test(pathname)
  ) {
    const url = request.nextUrl.clone()
    return NextResponse.rewrite(url)
  }

  return NextResponse.next()
}

// Use a broad negative matcher so Vercel runs middleware on ALL
// non-static paths. The narrow /trader/:path* matcher failed to
// match percent-encoded non-ASCII paths, causing the middleware
// to be skipped entirely.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|images|api/).*)'],
}
