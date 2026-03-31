/**
 * Redis-backed Rate Limiter with Circuit Breaker
 *
 * Shares rate limit state across all Vercel instances via Upstash Redis.
 * Falls back to in-memory TokenBucketRateLimiter if Redis is unavailable.
 *
 * Keys used:
 * - ratelimit:{platform}:{minute}       — sliding window counter (60s TTL)
 * - ratelimit:concurrent:{platform}     — active concurrent requests (30s TTL safety)
 * - circuit:{platform}                  — circuit breaker state (60s TTL)
 * - circuit:{platform}:failures         — consecutive failure count (120s TTL)
 */

import type { RateLimiter } from './types'
import { getSharedRedis, recordRedisError } from '../cache/redis-client'
import { TokenBucketRateLimiter } from './rate-limiter'
import { dataLogger } from '../utils/logger'

interface RedisRateLimiterConfig {
  /** Platform identifier for Redis key namespacing */
  platform: string
  /** Requests per minute */
  rpm: number
  /** Max concurrent requests */
  concurrency: number
  /** Consecutive failures before opening circuit */
  circuitBreakerThreshold: number
  /** How long to keep circuit open (ms) */
  circuitBreakerCooldown: number
}

const DEFAULT_CONFIG: Omit<RedisRateLimiterConfig, 'platform'> = {
  rpm: 20,
  concurrency: 2,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldown: 60000,
}

type CircuitValue = 'closed' | 'open' | 'half_open'

export class RedisRateLimiter implements RateLimiter {
  private readonly platform: string
  private readonly rpm: number
  private readonly maxConcurrency: number
  private readonly circuitBreakerThreshold: number
  private readonly circuitBreakerCooldownSec: number

  /** In-memory fallback when Redis is unavailable */
  private readonly fallback: TokenBucketRateLimiter
  /** Track whether we're using fallback to avoid repeated warnings */
  private usingFallback = false

  constructor(config: Partial<RedisRateLimiterConfig> & { platform: string }) {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    this.platform = cfg.platform
    this.rpm = cfg.rpm
    this.maxConcurrency = cfg.concurrency
    this.circuitBreakerThreshold = cfg.circuitBreakerThreshold
    this.circuitBreakerCooldownSec = Math.ceil(cfg.circuitBreakerCooldown / 1000)

    this.fallback = new TokenBucketRateLimiter({
      rpm: cfg.rpm,
      concurrency: cfg.concurrency,
      circuitBreakerThreshold: cfg.circuitBreakerThreshold,
      circuitBreakerCooldown: cfg.circuitBreakerCooldown,
    })
  }

  // ── Redis key helpers ──

  private get rpmKey(): string {
    const minute = Math.floor(Date.now() / 60000)
    return `ratelimit:${this.platform}:${minute}`
  }

  private get concurrencyKey(): string {
    return `ratelimit:concurrent:${this.platform}`
  }

  private get circuitKey(): string {
    return `circuit:${this.platform}`
  }

  private get failureKey(): string {
    return `circuit:${this.platform}:failures`
  }

  // ── Core interface ──

  async acquire(): Promise<void> {
    const redis = await getSharedRedis()
    if (!redis) {
      this.switchToFallback()
      return this.fallback.acquire()
    }

    try {
      // Retry loop: wait until we can acquire a slot
      let attempts = 0
      const maxAttempts = 30 // 30 * 200ms = 6s max wait

      while (attempts < maxAttempts) {
        // 1. Check circuit breaker
        const circuitState = await redis.get<CircuitValue>(this.circuitKey)
        if (circuitState === 'open') {
          break
        }

        // 2. Atomic check+acquire via pipeline (prevents TOCTOU race)
        // INCR first, then check the result — if over limit, DECR back
        const pipeline = redis.pipeline()
        pipeline.incr(this.rpmKey)
        pipeline.expire(this.rpmKey, 60)
        pipeline.incr(this.concurrencyKey)
        pipeline.expire(this.concurrencyKey, 30)
        const results = await pipeline.exec()

        const newRpm = (results[0] as number) ?? 0
        const newConcurrency = (results[2] as number) ?? 0

        // Check if we exceeded limits — if so, roll back and retry
        if (newRpm > this.rpm || newConcurrency > this.maxConcurrency) {
          // Roll back the increments
          const rollback = redis.pipeline()
          if (newRpm > this.rpm) rollback.decr(this.rpmKey)
          if (newConcurrency > this.maxConcurrency) rollback.decr(this.concurrencyKey)
          await rollback.exec()
          attempts++
          await sleep(200)
          continue
        }

        // Successfully acquired
        return
      }

      // Timed out — force acquire so release() stays balanced
      if (attempts >= maxAttempts) {
        const pipeline = redis.pipeline()
        pipeline.incr(this.rpmKey)
        pipeline.expire(this.rpmKey, 60)
        pipeline.incr(this.concurrencyKey)
        pipeline.expire(this.concurrencyKey, 30)
        await pipeline.exec()
      }
    } catch (error) {
      recordRedisError(error)
      this.switchToFallback()
      return this.fallback.acquire()
    }
  }

  release(): void {
    // Fire-and-forget Redis DECR
    getSharedRedis()
      .then(redis => {
        if (!redis) {
          this.fallback.release()
          return
        }
        return redis.decr(this.concurrencyKey).then(val => {
          // Don't let concurrency go negative
          if (val != null && val < 0) {
            redis.set(this.concurrencyKey, 0, { ex: 30 }).catch(err => console.warn(`[RedisRateLimiter] Failed to reset concurrency key ${this.concurrencyKey}:`, err instanceof Error ? err.message : String(err)))
          }
        })
      })
      .catch(() => {
        this.fallback.release()
      })
  }

  isCircuitOpen(): boolean {
    // This is sync in the interface, but we need Redis.
    // Use a cached value updated by recordSuccess/recordFailure.
    // For the sync check, also check fallback as a safety net.
    return this._cachedCircuitOpen ?? this.fallback.isCircuitOpen()
  }

  recordSuccess(): void {
    this._cachedCircuitOpen = false
    this.fallback.recordSuccess()

    getSharedRedis()
      .then(redis => {
        if (!redis) return
        const pipeline = redis.pipeline()
        pipeline.set(this.circuitKey, 'closed' as CircuitValue, { ex: this.circuitBreakerCooldownSec })
        pipeline.del(this.failureKey)
        return pipeline.exec()
      })
      .catch(err => recordRedisError(err))
  }

  recordFailure(): void {
    this.fallback.recordFailure()

    getSharedRedis()
      .then(async redis => {
        if (!redis) return

        const failures = await redis.incr(this.failureKey)
        await redis.expire(this.failureKey, 120) // 2min TTL on failure counter

        if (failures >= this.circuitBreakerThreshold) {
          await redis.set(this.circuitKey, 'open' as CircuitValue, {
            ex: this.circuitBreakerCooldownSec,
          })
          this._cachedCircuitOpen = true
          dataLogger.warn(
            `[RedisRateLimiter] Circuit OPEN for ${this.platform} (${failures} failures)`
          )
        }
      })
      .catch(err => recordRedisError(err))
  }

  getState(): { availablePermits: number; circuitOpen: boolean; consecutiveFailures: number } {
    // Sync method — return fallback state as best approximation.
    // The actual Redis state is authoritative but only accessible async.
    return this.fallback.getState()
  }

  // ── Async state accessors (for monitoring/debugging) ──

  /**
   * Get the full state from Redis. Use this for dashboards/debugging.
   */
  async getRedisState(): Promise<{
    rpm: number
    concurrency: number
    circuit: CircuitValue
    failures: number
  }> {
    const redis = await getSharedRedis()
    if (!redis) {
      const s = this.fallback.getState()
      return {
        rpm: 0,
        concurrency: 0,
        circuit: s.circuitOpen ? 'open' : 'closed',
        failures: s.consecutiveFailures,
      }
    }

    try {
      const pipeline = redis.pipeline()
      pipeline.get(this.rpmKey)
      pipeline.get(this.concurrencyKey)
      pipeline.get(this.circuitKey)
      pipeline.get(this.failureKey)
      const results = await pipeline.exec()

      return {
        rpm: (results[0] as number) ?? 0,
        concurrency: (results[1] as number) ?? 0,
        circuit: (results[2] as CircuitValue) ?? 'closed',
        failures: (results[3] as number) ?? 0,
      }
    } catch (error) {
      recordRedisError(error)
      return { rpm: 0, concurrency: 0, circuit: 'closed', failures: 0 }
    }
  }

  // ── Private helpers ──

  /** Cached circuit state for sync isCircuitOpen() */
  private _cachedCircuitOpen: boolean | null = null

  private switchToFallback(): void {
    if (!this.usingFallback) {
      this.usingFallback = true
      dataLogger.warn(
        `[RedisRateLimiter] Redis unavailable for ${this.platform}, using in-memory fallback`
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Create a Redis-backed rate limiter for a specific platform.
 */
export function createRedisRateLimiter(
  platform: string,
  rpm: number = 20,
  concurrency: number = 2
): RedisRateLimiter {
  return new RedisRateLimiter({ platform, rpm, concurrency })
}
