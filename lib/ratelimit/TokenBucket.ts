/**
 * Distributed Token Bucket Rate Limiter
 *
 * Uses ioredis (same client as BullMQ worker) for distributed token bucket.
 * Ensures multi-node deployments don't exceed exchange API rate limits.
 */

import Redis from 'ioredis'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('RateLimiter')

export interface RateLimitConfig {
  /** Token bucket capacity */
  capacity: number
  /** Tokens refilled per second */
  refillRate: number
  /** Redis key prefix */
  keyPrefix: string
  /** Token expiry (seconds) */
  ttl: number
}

export interface ExchangeRateLimits {
  [exchange: string]: RateLimitConfig
}

// Per-exchange default rate limit configs
export const DEFAULT_EXCHANGE_LIMITS: ExchangeRateLimits = {
  binance: {
    capacity: 1200,
    refillRate: 20,
    keyPrefix: 'rl:binance',
    ttl: 60,
  },
  bybit: {
    capacity: 600,
    refillRate: 10,
    keyPrefix: 'rl:bybit',
    ttl: 60,
  },
  okx: {
    capacity: 300,
    refillRate: 5,
    keyPrefix: 'rl:okx',
    ttl: 60,
  },
  bitget: {
    capacity: 600,
    refillRate: 10,
    keyPrefix: 'rl:bitget',
    ttl: 60,
  },
  mexc: {
    capacity: 300,
    refillRate: 5,
    keyPrefix: 'rl:mexc',
    ttl: 60,
  },
  htx: {
    capacity: 300,
    refillRate: 5,
    keyPrefix: 'rl:htx',
    ttl: 60,
  },
  hyperliquid: {
    capacity: 1200,
    refillRate: 20,
    keyPrefix: 'rl:hyperliquid',
    ttl: 60,
  },
  gmx: {
    capacity: 600,
    refillRate: 10,
    keyPrefix: 'rl:gmx',
    ttl: 60,
  },
  default: {
    capacity: 300,
    refillRate: 5,
    keyPrefix: 'rl:default',
    ttl: 60,
  },
}

// Redis Lua script: atomic token acquisition
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(bucket[1]) or capacity
local lastRefill = tonumber(bucket[2]) or now

local elapsed = math.max(0, now - lastRefill)
local refill = math.floor(elapsed * refillRate / 1000)
tokens = math.min(capacity, tokens + refill)

if tokens >= requested then
  tokens = tokens - requested
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  return {1, tokens, 0}
else
  local needed = requested - tokens
  local waitTime = math.ceil(needed * 1000 / refillRate)
  return {0, tokens, waitTime}
end
`

export class TokenBucketRateLimiter {
  private redis: Redis | null = null
  private exchangeLimits: ExchangeRateLimits
  private localFallback: Map<string, { tokens: number; lastRefill: number }> = new Map()
  private connected = false

  constructor(redisUrl?: string, exchangeLimits: Partial<ExchangeRateLimits> = {}) {
    const merged: ExchangeRateLimits = { ...DEFAULT_EXCHANGE_LIMITS }
    for (const [key, value] of Object.entries(exchangeLimits)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
    this.exchangeLimits = merged

    if (redisUrl) {
      this.initRedis(redisUrl)
    } else {
      logger.warn('No Redis URL provided, using local fallback (not distributed)')
    }
  }

  private initRedis(url: string): void {
    try {
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
      })
      this.redis.on('error', (err) => {
        logger.error('Redis error:', err)
        this.connected = false
      })
      this.redis.on('connect', () => {
        logger.info('Redis connected')
        this.connected = true
      })
    } catch (err) {
      logger.error('Failed to connect to Redis:', err)
      this.redis = null
    }
  }

  async acquire(
    exchange: string,
    tokens = 1
  ): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
    const config = this.exchangeLimits[exchange] || this.exchangeLimits.default
    const key = `${config.keyPrefix}:global`

    const result =
      this.redis && this.connected
        ? await this.acquireFromRedis(key, config, tokens)
        : this.acquireLocal(key, config, tokens)

    recordRateLimitDecision(exchange, result.allowed)

    if (!result.allowed) {
      logger.warn(`[RateLimit] denied for ${exchange}`, {
        exchange,
        remaining: result.remaining,
        retryAfter: result.retryAfter,
      })
    }

    return result
  }

  private async acquireFromRedis(
    key: string,
    config: RateLimitConfig,
    requested: number
  ): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
    try {
      const result = (await this.redis!.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        key,
        config.capacity.toString(),
        config.refillRate.toString(),
        Date.now().toString(),
        requested.toString(),
        config.ttl.toString()
      )) as [number, number, number]

      const [allowed, remaining, waitTime] = result

      return {
        allowed: allowed === 1,
        remaining,
        retryAfter: waitTime > 0 ? waitTime : undefined,
      }
    } catch (err) {
      logger.error('Redis acquire error:', err)
      return this.acquireLocal(key, config, requested)
    }
  }

  private acquireLocal(
    key: string,
    config: RateLimitConfig,
    requested: number
  ): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now()
    let bucket = this.localFallback.get(key)

    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefill: now }
      this.localFallback.set(key, bucket)
    }

    const elapsed = now - bucket.lastRefill
    const refill = Math.floor((elapsed * config.refillRate) / 1000)
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refill)
    bucket.lastRefill = now

    if (bucket.tokens >= requested) {
      bucket.tokens -= requested
      return { allowed: true, remaining: bucket.tokens }
    } else {
      const needed = requested - bucket.tokens
      const waitTime = Math.ceil((needed * 1000) / config.refillRate)
      return { allowed: false, remaining: bucket.tokens, retryAfter: waitTime }
    }
  }

  async getStatus(exchange: string): Promise<{
    exchange: string
    config: RateLimitConfig
    remaining: number
    capacity: number
  }> {
    const config = this.exchangeLimits[exchange] || this.exchangeLimits.default
    const key = `${config.keyPrefix}:global`

    let remaining = config.capacity

    if (this.redis && this.connected) {
      try {
        const tokens = await this.redis.hget(key, 'tokens')
        if (tokens) remaining = parseInt(tokens, 10)
      } catch (_err) {
        /* Redis read failed; fall through to default */
      }
    } else {
      const bucket = this.localFallback.get(key)
      if (bucket) remaining = bucket.tokens
    }

    return { exchange, config, remaining, capacity: config.capacity }
  }

  async withRateLimit<T>(exchange: string, fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { allowed, retryAfter } = await this.acquire(exchange)

      if (allowed) {
        return fn()
      }

      if (retryAfter && attempt < maxRetries - 1) {
        logger.info(`Rate limited for ${exchange}, waiting ${retryAfter}ms`)
        await new Promise((r) => setTimeout(r, retryAfter))
      }
    }

    throw new Error(`Rate limit exceeded for ${exchange} after ${maxRetries} retries`)
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit()
      this.redis = null
      this.connected = false
    }
  }
}

// Singleton
let rateLimiter: TokenBucketRateLimiter | null = null

export function getRateLimiter(): TokenBucketRateLimiter {
  if (!rateLimiter) {
    rateLimiter = new TokenBucketRateLimiter(process.env.REDIS_URL)
  }
  return rateLimiter
}

// ---------------------------------------------------------------------------
// Rate-limit hit tracking (observability)
// ---------------------------------------------------------------------------

interface RateLimitStats {
  allowed: number
  denied: number
  lastDeniedAt: number | null
}

const _rateLimitStats = new Map<string, RateLimitStats>()

export function recordRateLimitDecision(exchange: string, allowed: boolean): void {
  const existing = _rateLimitStats.get(exchange) ?? { allowed: 0, denied: 0, lastDeniedAt: null }
  if (allowed) {
    existing.allowed++
  } else {
    existing.denied++
    existing.lastDeniedAt = Date.now()
  }
  _rateLimitStats.set(exchange, existing)
}

export function getRateLimitStats(): Record<
  string,
  {
    allowed: number
    denied: number
    denialRate: number
    lastDeniedAt: string | null
  }
> {
  const out: Record<
    string,
    {
      allowed: number
      denied: number
      denialRate: number
      lastDeniedAt: string | null
    }
  > = {}
  for (const [exchange, s] of _rateLimitStats.entries()) {
    const total = s.allowed + s.denied
    out[exchange] = {
      allowed: s.allowed,
      denied: s.denied,
      denialRate: total > 0 ? Math.round((s.denied / total) * 1000) / 10 : 0,
      lastDeniedAt: s.lastDeniedAt ? new Date(s.lastDeniedAt).toISOString() : null,
    }
  }
  return out
}

export default TokenBucketRateLimiter
