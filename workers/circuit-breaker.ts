/**
 * Circuit Breaker implementation for platform-level fault isolation
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests blocked
 * - HALF_OPEN: Testing if service recovered
 */

export interface CircuitBreakerConfig {
  failureThreshold: number;  // Failures before opening
  resetTimeout: number;      // Ms before attempting half-open
  halfOpenMaxAttempts: number; // Attempts in half-open before closing
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly config: CircuitBreakerConfig;
  private readonly name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeout: config.resetTimeout ?? 300000, // 5 minutes
      halfOpenMaxAttempts: config.halfOpenMaxAttempts ?? 2,
    };
  }

  canExecute(): boolean {
    switch (this.state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if reset timeout has passed
        if (Date.now() - this.lastFailureTime >= this.config.resetTimeout) {
          this.state = 'HALF_OPEN';
          this.halfOpenAttempts = 0;
          console.log(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN`);
          return true;
        }
        return false;

      case 'HALF_OPEN':
        return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
    }
  }

  recordSuccess(): void {
    switch (this.state) {
      case 'HALF_OPEN':
        this.halfOpenAttempts++;
        if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
          this.reset();
          console.log(`[CircuitBreaker:${this.name}] Recovered, transitioning to CLOSED`);
        }
        break;

      case 'CLOSED':
        // Reset failure count on success
        if (this.failures > 0) {
          this.failures = Math.max(0, this.failures - 1);
        }
        break;
    }
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    switch (this.state) {
      case 'CLOSED':
        if (this.failures >= this.config.failureThreshold) {
          this.state = 'OPEN';
          console.log(`[CircuitBreaker:${this.name}] OPENED after ${this.failures} failures`);
        }
        break;

      case 'HALF_OPEN':
        this.state = 'OPEN';
        console.log(`[CircuitBreaker:${this.name}] Failed in HALF_OPEN, re-opening`);
        break;
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.halfOpenAttempts = 0;
  }

  getState(): { state: CircuitState; failures: number; lastFailure: number } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailureTime,
    };
  }
}
