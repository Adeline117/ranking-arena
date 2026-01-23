/**
 * Rate Limiter with Circuit Breaker
 *
 * Provides per-platform rate limiting with:
 * - Token bucket for RPM control
 * - Semaphore for concurrency control
 * - Circuit breaker for fault tolerance
 */

import type { RateLimiter } from './types'

interface RateLimiterConfig {
  /** Requests per minute */
  rpm: number
  /** Max concurrent requests */
  concurrency: number
  /** Number of consecutive failures before opening circuit */
  circuitBreakerThreshold: number
  /** How long to keep circuit open (ms) */
  circuitBreakerCooldown: number
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  rpm: 20,
  concurrency: 2,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldown: 60000, // 1 minute
}

export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number
  private maxTokens: number
  private refillRate: number  // tokens per ms
  private lastRefill: number
  private activeConcurrency: number
  private maxConcurrency: number
  private consecutiveFailures: number = 0
  private circuitOpenUntil: number = 0
  private readonly circuitBreakerThreshold: number
  private readonly circuitBreakerCooldown: number
  private waitQueue: Array<() => void> = []

  constructor(config?: Partial<RateLimiterConfig>) {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    this.maxTokens = cfg.rpm
    this.tokens = cfg.rpm
    this.refillRate = cfg.rpm / 60000  // tokens per ms
    this.lastRefill = Date.now()
    this.activeConcurrency = 0
    this.maxConcurrency = cfg.concurrency
    this.circuitBreakerThreshold = cfg.circuitBreakerThreshold
    this.circuitBreakerCooldown = cfg.circuitBreakerCooldown
  }

  async acquire(): Promise<void> {
    // Refill tokens
    this.refill()

    // Wait for token availability
    while (this.tokens < 1 || this.activeConcurrency >= this.maxConcurrency) {
      await this.waitForToken()
      this.refill()
    }

    this.tokens -= 1
    this.activeConcurrency += 1
  }

  release(): void {
    this.activeConcurrency = Math.max(0, this.activeConcurrency - 1)
    // Notify waiting requests
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()
      next?.()
    }
  }

  isCircuitOpen(): boolean {
    if (this.circuitOpenUntil === 0) return false
    if (Date.now() > this.circuitOpenUntil) {
      // Circuit half-open: allow one request through
      this.circuitOpenUntil = 0
      this.consecutiveFailures = 0
      return false
    }
    return true
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.circuitOpenUntil = 0
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitBreakerCooldown
    }
  }

  getState() {
    this.refill()
    return {
      availablePermits: Math.floor(this.tokens),
      circuitOpen: this.isCircuitOpen(),
      consecutiveFailures: this.consecutiveFailures,
    }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    const newTokens = elapsed * this.refillRate
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens)
    this.lastRefill = now
  }

  private waitForToken(): Promise<void> {
    return new Promise(resolve => {
      // Calculate wait time
      const waitMs = this.tokens < 1
        ? Math.ceil((1 - this.tokens) / this.refillRate)
        : 100  // Concurrency wait

      const timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(resolve)
        if (idx >= 0) this.waitQueue.splice(idx, 1)
        resolve()
      }, Math.min(waitMs, 5000)) // Max 5s wait

      this.waitQueue.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/**
 * Create a rate limiter for a specific platform.
 */
export function createRateLimiter(
  rpm: number = 20,
  concurrency: number = 2
): TokenBucketRateLimiter {
  return new TokenBucketRateLimiter({ rpm, concurrency })
}
