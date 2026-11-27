/**
 * Shared Redis client singleton
 *
 * Both `index.ts` and `redis-layer.ts` use this single Upstash client
 * to avoid duplicate connections and initialization overhead.
 */

import { dataLogger } from '@/lib/utils/logger'
import {
  RedisCircuitOpenError,
  closeRedisCircuit,
  recordRedisFailure,
  recordRedisSuccess,
  redisCircuitAllowsRequest,
  redisCircuitCoolingDown,
  redisCircuitTripped,
} from './redis-circuit'
import { reportRedisFailure } from './redis-outage'

type UpstashRedisType = InstanceType<(typeof import('@upstash/redis'))['Redis']>

/** Raw SDK client: used only by pingRedis, which must bypass the circuit. */
let rawClient: UpstashRedisType | null = null
/** What callers receive: every round trip is gated and observed. */
let redisClient: UpstashRedisType | null = null
let initialized = false

/**
 * Get the shared Redis client. Returns null if unconfigured, in the browser,
 * or while the circuit breaker is cooling down after a failure.
 */
export async function getSharedRedis(): Promise<UpstashRedisType | null> {
  if (typeof window !== 'undefined') return null

  if (!initialized) {
    initialized = true

    const url = process.env.UPSTASH_REDIS_REST_URL
    const token = process.env.UPSTASH_REDIS_REST_TOKEN

    if (!url || !token) {
      dataLogger.warn('[Redis] env vars not configured, using memory cache')
      return null
    }

    try {
      const { Redis } = await import('@upstash/redis')
      // CRITICAL: Upstash SDK defaults to `cache: 'no-store'` on its internal fetch calls.
      // This causes Next.js to treat ANY page that touches Redis as fully dynamic,
      // breaking ISR on /rankings/[exchange], homepage, and all cached pages.
      // Use the SDK's supported cache option. The previous custom `fetch` field is
      // not part of RedisConfigNodejs, was ignored at runtime, and `as any` hid it.
      // Redis commands are POST requests, so the browser/HTTP default does not
      // cache their responses; it only avoids explicitly opting the route out of ISR.
      rawClient = new Redis({ url, token, enableAutoPipelining: true, cache: 'default' })
      redisClient = withCircuit(rawClient)
      dataLogger.info('[Redis] connected')
    } catch (error) {
      dataLogger.error('[Redis] init failed:', error)
      return null
    }
  }

  if (!redisClient || redisCircuitCoolingDown()) return null
  return redisClient
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Run one Redis round trip through the circuit breaker. */
function guarded(run: () => unknown): unknown {
  if (!redisCircuitAllowsRequest()) return Promise.reject(new RedisCircuitOpenError())
  const result = run()
  if (isThenable(result)) result.then(recordRedisSuccess, recordRedisError)
  return result
}

/**
 * Wrap the SDK client so every command (and pipeline `exec`) is gated and
 * observed in one place. Call sites cannot forget to report a failure, and a
 * client reference captured before the circuit opened stops sending requests.
 */
function withCircuit(client: UpstashRedisType): UpstashRedisType {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop === 'pipeline' || prop === 'multi') {
        // Building a pipeline is local; only exec() talks to Redis.
        return (...args: unknown[]) => {
          const pipeline: unknown = Reflect.apply(value, target, args)
          if (typeof pipeline !== 'object' || pipeline === null) return pipeline
          const exec: unknown = Reflect.get(pipeline, 'exec')
          if (typeof exec === 'function') {
            Reflect.set(pipeline, 'exec', (...execArgs: unknown[]) =>
              guarded(() => Reflect.apply(exec, pipeline, execArgs))
            )
          }
          return pipeline
        }
      }
      return (...args: unknown[]) => guarded(() => Reflect.apply(value, target, args))
    },
  })
}

/**
 * Record a Redis error. The first failure opens the circuit and alerts.
 */
export function recordRedisError(error: unknown): void {
  reportRedisFailure(error)
}

/**
 * Check if Redis is currently considered available.
 */
export function isRedisAvailable(): boolean {
  if (initialized && !redisClient) return false
  return !redisCircuitTripped()
}

/**
 * Ping Redis and update health status. Explicit health checks bypass the
 * circuit so an operator probe always reflects the live service.
 */
export async function pingRedis(): Promise<boolean> {
  if (!rawClient) return false
  try {
    await rawClient.ping()
    if (redisCircuitTripped()) dataLogger.info('[Redis] connection recovered')
    closeRedisCircuit()
    return true
  } catch (err) {
    dataLogger.warn('[Redis] ping failed:', err instanceof Error ? err.message : String(err))
    recordRedisFailure()
    return false
  }
}
