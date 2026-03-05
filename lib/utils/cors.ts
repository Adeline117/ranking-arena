/**
 * CORS utilities for API routes
 * Provides secure CORS handling with allowed origins whitelist
 */

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  // Production domains
  'https://www.arenafi.org',
  'https://arenafi.org',
  'https://ranking-arena.vercel.app',
  // Preview deployments (Vercel)
  /^https:\/\/ranking-arena-.*\.vercel\.app$/,
  // Development
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

/**
 * Check if an origin is allowed
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false

  return ALLOWED_ORIGINS.some(allowed => {
    if (typeof allowed === 'string') {
      return origin === allowed
    }
    // RegExp for pattern matching (e.g., preview deployments)
    return allowed.test(origin)
  })
}

/**
 * Get the CORS origin header value
 * Returns the origin if allowed, otherwise returns the first allowed origin
 */
export function getCorsOrigin(origin: string | null): string {
  if (origin && isAllowedOrigin(origin)) {
    return origin
  }
  // Default to primary production domain
  return 'https://www.arenafi.org'
}

/**
 * Get CORS headers for a request
 */
export function getCorsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(origin),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

/**
 * Handle CORS preflight request
 */
export function handleCorsPrelight(request: Request): Response {
  const origin = request.headers.get('Origin')
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin),
  })
}
