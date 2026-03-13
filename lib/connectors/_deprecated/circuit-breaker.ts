/**
 * Minimal circuit breaker implementation for platform connectors.
 * Prevents cascading failures when a platform API is down.
 */

import type { CircuitBreaker, CircuitState } from '../types'

export class SimpleCircuitBreaker implements CircuitBreaker {
  private _state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private successCount = 0

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly recoveryTimeMs: number = 60000,
    private readonly halfOpenSuccessThreshold: number = 2,
  ) {}

  get state(): CircuitState {
    if (this._state === 'open') {
      // Check if recovery time has elapsed
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this._state = 'half-open'
        this.successCount = 0
      }
    }
    return this._state
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state

    if (currentState === 'open') {
      throw new CircuitBreakerOpenError(
        `Circuit breaker is open. Will retry after ${Math.ceil((this.lastFailureTime + this.recoveryTimeMs - Date.now()) / 1000)}s`
      )
    }

    try {
      const result = await fn()
      this.recordSuccess()
      return result
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }

  recordSuccess(): void {
    if (this._state === 'half-open') {
      this.successCount++
      if (this.successCount >= this.halfOpenSuccessThreshold) {
        this._state = 'closed'
        this.failureCount = 0
        this.successCount = 0
      }
    } else {
      this.failureCount = Math.max(0, this.failureCount - 1)
    }
  }

  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.failureCount >= this.failureThreshold) {
      this._state = 'open'
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitBreakerOpenError'
  }
}

/**
 * Circuit Breaker Manager for managing multiple breakers by key
 */
class CircuitBreakerManager {
  private breakers = new Map<string, ManagedCircuitBreaker>()
  private readonly defaultConfig = {
    failureThreshold: 5,
    recoveryTimeMs: 60000,
    halfOpenSuccessThreshold: 2,
  }

  get(key: string): ManagedCircuitBreaker {
    if (!this.breakers.has(key)) {
      this.breakers.set(key, new ManagedCircuitBreaker(
        this.defaultConfig.failureThreshold,
        this.defaultConfig.recoveryTimeMs,
        this.defaultConfig.halfOpenSuccessThreshold
      ))
    }
    return this.breakers.get(key)!
  }
}

/**
 * Managed Circuit Breaker with additional methods for the cron API
 */
class ManagedCircuitBreaker extends SimpleCircuitBreaker {
  private openTime = 0

  getState(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    const state = this.state
    if (state === 'closed') return 'CLOSED'
    if (state === 'open') return 'OPEN'
    return 'HALF_OPEN'
  }

  getStats(): { remainingCooldown: number } {
    if (this.getState() === 'OPEN') {
      const elapsed = Date.now() - this.openTime
      const remaining = Math.max(0, 60000 - elapsed)
      return { remainingCooldown: remaining }
    }
    return { remainingCooldown: 0 }
  }

  recordFailure(): void {
    super.recordFailure()
    if (this.state === 'open') {
      this.openTime = Date.now()
    }
  }
}

// Export singleton manager
export const circuitBreakerManager = new CircuitBreakerManager()
