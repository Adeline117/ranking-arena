/**
 * Shared Redis client singleton
 *
 * Both `index.ts` and `redis-layer.ts` use this single Upstash client
 * to avoid duplicate connections and initialization overhead.
 */

import { dataLogger } from '@/lib/utils/logger'

type UpstashRedisType = InstanceType<typeof import('@upstash/redis')['Redis']>

let redisClient: UpstashRedisType | null = null
let initialized = false
let healthy = true
let lastHealthCheck = 0
let consecutiveErrors = 0

const HEALTH_CHECK_INTERVAL = 30_000 // 30s
const MAX_CONSECUTIVE_ERRORS = 3

/**
 * Get the shared Redis client. Returns null if unavailable or in browser.
 */
export async function getSharedRedis(): Promise<UpstashRedisType | null> {
  if (typeof window !== 'undefined') return null

  if (initialized && redisClient) {
    if (!healthy) {
      const now = Date.now()
      if (now - lastHealthCheck > HEALTH_CHECK_INTERVAL) {
        lastHealthCheck = now
        pingRedis().catch(() => {})
      }
    }
    return healthy ? redisClient : null
  }

  if (initialized && !redisClient) return null

  initialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    dataLogger.warn('[Redis] env vars not configured, using memory cache')
    healthy = false
    return null
  }

  try {
    const { Redis } = await import('@upstash/redis')
    // CRITICAL: Upstash SDK defaults to `cache: 'no-store'` on its internal fetch calls.
    // This causes Next.js to treat ANY page that touches Redis as fully dynamic,
    // breaking ISR on /rankings/[exchange], homepage, and all cached pages.
    // Solution: pass a custom fetch wrapper that replaces 'no-store' with revalidate.
    const isrSafeFetch: typeof fetch = (input, init) => {
      if (init?.cache === 'no-store') {
        const { cache: _, ...rest } = init
        return fetch(input, { ...rest, next: { revalidate: 60 } })
      }
      return fetch(input, init)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redisClient = new Redis({ url, token, enableAutoPipelining: true, fetch: isrSafeFetch } as any)
    dataLogger.info('[Redis] connected')
    return redisClient
  } catch (error) {
    dataLogger.error('[Redis] init failed:', error)
    healthy = false
    return null
  }
}

/**
 * Record a Redis error. After MAX_CONSECUTIVE_ERRORS, marks Redis as unhealthy.
 */
export function recordRedisError(error: unknown): void {
  consecutiveErrors++
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && healthy) {
    dataLogger.warn(`[Redis] ${consecutiveErrors} consecutive errors, switching to memory cache`)
    healthy = false
    lastHealthCheck = Date.now()
  }
}

/**
 * Check if Redis is currently considered available.
 */
export function isRedisAvailable(): boolean {
  return healthy
}

/**
 * Ping Redis and update health status.
 */
export async function pingRedis(): Promise<boolean> {
  if (!redisClient) return false
  try {
    await redisClient.ping()
    if (!healthy) dataLogger.info('[Redis] connection recovered')
    healthy = true
    consecutiveErrors = 0
    return true
  } catch {
    healthy = false
    return false
  }
}
