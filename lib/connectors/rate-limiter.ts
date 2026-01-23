/**
 * Per-platform rate limiter with token bucket algorithm.
 * Ensures we don't exceed request limits for any exchange.
 */

import type { RateLimiter } from './types'

export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number
  private lastRefill: number
  private queue: Array<() => void> = []

  constructor(
    private readonly maxTokens: number = 2,
    private readonly refillIntervalMs: number = 2000,
  ) {
    this.tokens = maxTokens
    this.lastRefill = Date.now()
  }

  async acquire(): Promise<void> {
    this.refill()

    if (this.tokens > 0) {
      this.tokens--
      return
    }

    // Wait for a token to become available
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
      // Schedule a check after refill interval
      setTimeout(() => this.processQueue(), this.refillIntervalMs)
    })
  }

  release(): void {
    this.tokens = Math.min(this.tokens + 1, this.maxTokens)
    this.processQueue()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs)

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.tokens + tokensToAdd, this.maxTokens)
      this.lastRefill = now
    }
  }

  private processQueue(): void {
    this.refill()
    while (this.queue.length > 0 && this.tokens > 0) {
      this.tokens--
      const resolve = this.queue.shift()
      resolve?.()
    }
  }
}

/**
 * Simple delay-based rate limiter.
 * Guarantees minimum delay between requests.
 */
export class DelayRateLimiter implements RateLimiter {
  private lastRequest = 0
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly minDelayMs: number = 2000) {}

  async acquire(): Promise<void> {
    // Chain requests to ensure sequential delays
    this.pending = this.pending.then(async () => {
      const now = Date.now()
      const elapsed = now - this.lastRequest
      if (elapsed < this.minDelayMs) {
        await sleep(this.minDelayMs - elapsed + randomJitter(500))
      }
      this.lastRequest = Date.now()
    })
    return this.pending
  }

  release(): void {
    // No-op for delay limiter
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomJitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs)
}
