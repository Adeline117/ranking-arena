/**
 * In-memory rate limiter for API routes.
 * Uses a sliding window counter per IP.
 * 
 * For production, replace with Redis-backed limiter (Upstash @upstash/ratelimit).
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Cleanup stale entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt < now) store.delete(key)
    }
  }, 5 * 60 * 1000)
}

interface RateLimitConfig {
  /** Max requests per window */
  limit: number
  /** Window size in seconds */
  windowSec: number
}

interface RateLimitResult {
  success: boolean
  limit: number
  remaining: number
  resetAt: number
}

/**
 * Check rate limit for a given identifier (usually IP or user ID).
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = { limit: 60, windowSec: 60 }
): RateLimitResult {
  const now = Date.now()
  const key = identifier
  const entry = store.get(key)

  if (!entry || entry.resetAt < now) {
    // New window
    const resetAt = now + config.windowSec * 1000
    store.set(key, { count: 1, resetAt })
    return { success: true, limit: config.limit, remaining: config.limit - 1, resetAt }
  }

  entry.count++
  const remaining = Math.max(0, config.limit - entry.count)

  if (entry.count > config.limit) {
    return { success: false, limit: config.limit, remaining: 0, resetAt: entry.resetAt }
  }

  return { success: true, limit: config.limit, remaining, resetAt: entry.resetAt }
}

/**
 * Add rate limit headers to a Response/Headers object.
 */
export function setRateLimitHeaders(
  headers: Headers,
  result: RateLimitResult
): void {
  headers.set('X-RateLimit-Limit', String(result.limit))
  headers.set('X-RateLimit-Remaining', String(result.remaining))
  headers.set('X-RateLimit-Reset', String(Math.floor(result.resetAt / 1000)))
}

/**
 * Extract client IP from Next.js request.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  const real = request.headers.get('x-real-ip')
  if (real) return real
  return '127.0.0.1'
}
