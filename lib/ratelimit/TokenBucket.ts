/**
 * Distributed Token Bucket Rate Limiter
 * 
 * 使用 Redis 实现分布式令牌桶，针对不同交易所 API 限流
 * 确保多节点部署时不会因单个节点过快导致所有节点被封禁 IP
 */

import { createClient, RedisClientType } from 'redis'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('RateLimiter')

export interface RateLimitConfig {
  /** 令牌桶容量 */
  capacity: number
  /** 每秒补充令牌数 */
  refillRate: number
  /** Redis key 前缀 */
  keyPrefix: string
  /** 令牌过期时间 (秒) */
  ttl: number
}

export interface ExchangeRateLimits {
  [exchange: string]: RateLimitConfig
}

// 各交易所默认限流配置
export const DEFAULT_EXCHANGE_LIMITS: ExchangeRateLimits = {
  binance: {
    capacity: 1200,      // 每分钟 1200 请求
    refillRate: 20,      // 每秒 20 令牌
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

// Redis Lua 脚本: 原子性获取令牌
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

-- 获取当前桶状态
local bucket = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(bucket[1]) or capacity
local lastRefill = tonumber(bucket[2]) or now

-- 计算补充的令牌
local elapsed = math.max(0, now - lastRefill)
local refill = math.floor(elapsed * refillRate / 1000)
tokens = math.min(capacity, tokens + refill)

-- 检查是否有足够令牌
if tokens >= requested then
  tokens = tokens - requested
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  return {1, tokens, 0}  -- 成功, 剩余令牌, 等待时间
else
  -- 计算需要等待的时间
  local needed = requested - tokens
  local waitTime = math.ceil(needed * 1000 / refillRate)
  return {0, tokens, waitTime}  -- 失败, 剩余令牌, 等待时间
end
`

export class TokenBucketRateLimiter {
  private redis: RedisClientType | null = null
  private exchangeLimits: ExchangeRateLimits
  private localFallback: Map<string, { tokens: number; lastRefill: number }> = new Map()
  private connected = false

  constructor(
    redisUrl?: string,
    exchangeLimits: Partial<ExchangeRateLimits> = {}
  ) {
    // Merge with defaults, filtering out undefined values
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

  private async initRedis(url: string): Promise<void> {
    try {
      this.redis = createClient({ url })
      this.redis.on('error', (err) => {
        logger.error('Redis error:', err)
        this.connected = false
      })
      this.redis.on('connect', () => {
        logger.info('Redis connected')
        this.connected = true
      })
      await this.redis.connect()
    } catch (err) {
      logger.error('Failed to connect to Redis:', err)
      this.redis = null
    }
  }

  /**
   * 请求令牌
   * @returns { allowed: boolean, remaining: number, retryAfter?: number }
   */
  async acquire(
    exchange: string,
    tokens = 1
  ): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
    const config = this.exchangeLimits[exchange] || this.exchangeLimits.default
    const key = `${config.keyPrefix}:global`

    const result = (this.redis && this.connected)
      ? await this.acquireFromRedis(key, config, tokens)
      : this.acquireLocal(key, config, tokens)

    // Observability: record every decision so we know when we start hitting
    // upstream rate limits before cascading failures happen downstream.
    recordRateLimitDecision(exchange, result.allowed)

    // Warn on denial — surfaces in logs + Sentry fingerprinted by exchange.
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
      const result = await this.redis!.eval(TOKEN_BUCKET_SCRIPT, {
        keys: [key],
        arguments: [
          config.capacity.toString(),
          config.refillRate.toString(),
          Date.now().toString(),
          requested.toString(),
          config.ttl.toString(),
        ],
      }) as [number, number, number]

      const [allowed, remaining, waitTime] = result

      return {
        allowed: allowed === 1,
        remaining,
        retryAfter: waitTime > 0 ? waitTime : undefined,
      }
    } catch (err) {
      logger.error('Redis acquire error:', err)
      // 降级到本地
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

    // 补充令牌
    const elapsed = now - bucket.lastRefill
    const refill = Math.floor(elapsed * config.refillRate / 1000)
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refill)
    bucket.lastRefill = now

    // 检查令牌
    if (bucket.tokens >= requested) {
      bucket.tokens -= requested
      return { allowed: true, remaining: bucket.tokens }
    } else {
      const needed = requested - bucket.tokens
      const waitTime = Math.ceil(needed * 1000 / config.refillRate)
      return { allowed: false, remaining: bucket.tokens, retryAfter: waitTime }
    }
  }

  /**
   * 获取当前限流状态
   */
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
        const tokens = await this.redis.hGet(key, 'tokens')
        if (tokens) remaining = parseInt(tokens, 10)
      } catch (_err) { /* Redis read failed; fall through to return default remaining count */ }
    } else {
      const bucket = this.localFallback.get(key)
      if (bucket) remaining = bucket.tokens
    }

    return {
      exchange,
      config,
      remaining,
      capacity: config.capacity,
    }
  }

  /**
   * 带重试的请求包装器
   */
  async withRateLimit<T>(
    exchange: string,
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { allowed, retryAfter } = await this.acquire(exchange)

      if (allowed) {
        return fn()
      }

      if (retryAfter && attempt < maxRetries - 1) {
        logger.info(`Rate limited for ${exchange}, waiting ${retryAfter}ms`)
        await new Promise(r => setTimeout(r, retryAfter))
      }
    }

    throw new Error(`Rate limit exceeded for ${exchange} after ${maxRetries} retries`)
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit()
      this.redis = null
      this.connected = false
    }
  }
}

// 单例
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
//
// Previously, `acquire()` silently returned `{ allowed: false }` when the
// bucket was empty. There was no counter, log, or alert — meaning if Binance
// started rate-limiting us, we'd only find out when downstream fetchers
// failed. This tracker surfaces denials per-exchange so /api/health/pipeline
// and monitor scripts can see them.
//
// In-memory only (resets on cold start) — acceptable because cron jobs run
// every 5-30min and Binance-type rate limits are on the order of 1200/min,
// so a single instance sees meaningful data within one request window.

interface RateLimitStats {
  allowed: number
  denied: number
  lastDeniedAt: number | null
}

const _rateLimitStats = new Map<string, RateLimitStats>()

/** Record an allow/deny decision for observability. */
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

/**
 * Snapshot of rate-limit stats per exchange since process start.
 * Denial ratio > 10% indicates we're hitting rate limits and should back off.
 */
export function getRateLimitStats(): Record<string, {
  allowed: number
  denied: number
  denialRate: number
  lastDeniedAt: string | null
}> {
  const out: Record<string, {
    allowed: number
    denied: number
    denialRate: number
    lastDeniedAt: string | null
  }> = {}
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
