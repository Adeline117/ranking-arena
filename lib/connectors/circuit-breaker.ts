/**
 * Minimal circuit breaker implementation for platform connectors.
 * Prevents cascading failures when a platform API is down.
 */

import type { CircuitBreaker, CircuitState } from './types'

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
