/**
 * Exchange Rate Limiter
 * Uses Upstash Redis for distributed rate limiting across multiple instances
 *
 * Algorithm: Sliding Window
 * - More accurate than fixed window
 * - Prevents burst at window boundaries
 */

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { logger } from '@/lib/logger'

export interface RateLimiterConfig {
  exchangeName: string
  limit: number // Max requests
  period: number // Period in seconds
  redis?: Redis
}

export class ExchangeRateLimiter {
  private limiter: Ratelimit
  private exchangeName: string

  constructor(config: RateLimiterConfig) {
    this.exchangeName = config.exchangeName

    // Use provided Redis instance or create new one
    const redis =
      config.redis ||
      new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      })

    // Create sliding window rate limiter
    this.limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.limit, `${config.period}s`),
      prefix: `ratelimit:${config.exchangeName}`,
      analytics: true, // Enable analytics for monitoring
    })
  }

  /**
   * Check rate limit and wait if necessary
   * Returns true if request is allowed, false if rate limited
   */
  async checkLimit(identifier: string = 'global'): Promise<{
    success: boolean
    limit: number
    remaining: number
    reset: number
    retryAfter?: number
  }> {
    try {
      const result = await this.limiter.limit(identifier)

      if (!result.success) {
        const retryAfter = Math.ceil((result.reset - Date.now()) / 1000)
        logger.warn(
          `[RateLimit] ${this.exchangeName} rate limit exceeded`,
          {
            identifier,
            retryAfter,
            limit: result.limit,
            reset: new Date(result.reset),
          }
        )
      }

      return {
        success: result.success,
        limit: result.limit,
        remaining: result.remaining,
        reset: result.reset,
        retryAfter: result.success
          ? undefined
          : Math.ceil((result.reset - Date.now()) / 1000),
      }
    } catch (error) {
      logger.error(`[RateLimit] ${this.exchangeName} check failed`, { error })
      // On error, allow the request (fail open)
      return {
        success: true,
        limit: 0,
        remaining: 0,
        reset: Date.now(),
      }
    }
  }

  /**
   * Wait for rate limit to reset if exceeded
   */
  async waitForLimit(identifier: string = 'global'): Promise<void> {
    const result = await this.checkLimit(identifier)

    if (!result.success && result.retryAfter) {
      logger.info(
        `[RateLimit] ${this.exchangeName} waiting ${result.retryAfter}s for rate limit reset`,
        { identifier }
      )
      await this.sleep(result.retryAfter * 1000)
    }
  }

  /**
   * Execute function with rate limiting
   */
  async execute<T>(
    fn: () => Promise<T>,
    identifier: string = 'global'
  ): Promise<T> {
    await this.waitForLimit(identifier)
    return fn()
  }

  /**
   * Get current rate limit status
   */
  async getStatus(identifier: string = 'global'): Promise<{
    remaining: number
    limit: number
    reset: Date
  }> {
    const result = await this.checkLimit(identifier)
    return {
      remaining: result.remaining,
      limit: result.limit,
      reset: new Date(result.reset),
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Predefined rate limiters for common exchanges
 */
export class ExchangeRateLimiters {
  private static limiters: Map<string, ExchangeRateLimiter> = new Map()
  private static redis?: Redis

  /**
   * Initialize shared Redis instance
   */
  static initialize() {
    if (!this.redis) {
      this.redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      })
    }
  }

  /**
   * Get or create rate limiter for exchange
   */
  static get(exchangeName: string): ExchangeRateLimiter {
    if (!this.limiters.has(exchangeName)) {
      this.initialize()
      const config = this.getExchangeConfig(exchangeName)
      this.limiters.set(
        exchangeName,
        new ExchangeRateLimiter({ ...config, redis: this.redis })
      )
    }
    return this.limiters.get(exchangeName)!
  }

  /**
   * Get rate limit config for exchange
   */
  private static getExchangeConfig(exchangeName: string): RateLimiterConfig {
    const configs: Record<string, RateLimiterConfig> = {
      binance: {
        exchangeName: 'binance',
        limit: 2400,
        period: 60, // 2400 requests per minute
      },
      bybit: {
        exchangeName: 'bybit',
        limit: 120,
        period: 1, // 120 requests per second
      },
      okx: {
        exchangeName: 'okx',
        limit: 20,
        period: 2, // 20 requests per 2 seconds
      },
      bitget: {
        exchangeName: 'bitget',
        limit: 20,
        period: 1, // 20 requests per second
      },
      gateio: {
        exchangeName: 'gateio',
        limit: 900,
        period: 1, // 900 requests per second
      },
      mexc: {
        exchangeName: 'mexc',
        limit: 20,
        period: 1, // 20 requests per second
      },
    }

    return (
      configs[exchangeName.toLowerCase()] || {
        exchangeName,
        limit: 10, // Default: 10 requests per second
        period: 1,
      }
    )
  }

  /**
   * Get all rate limiter statuses
   */
  static async getAllStatuses(): Promise<
    Record<string, { remaining: number; limit: number; reset: Date }>
  > {
    const statuses: Record<
      string,
      { remaining: number; limit: number; reset: Date }
    > = {}

    for (const [name, limiter] of this.limiters) {
      statuses[name] = await limiter.getStatus()
    }

    return statuses
  }
}
