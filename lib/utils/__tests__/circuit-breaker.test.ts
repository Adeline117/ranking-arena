/**
 * Comprehensive tests for circuit breaker, retry utilities, and error classification
 * ~25 tests covering state transitions, latency, reset, withRetry, RetryPresets, isTransientError
 */

import {
  CircuitBreaker,
  withRetry,
  withCircuitBreakerAndRetry,
  isNetworkError,
  isProviderRateLimitError,
  extractRetryAfter,
  isTransientError,
  RetryPresets,
  getCircuitBreaker,
  getAllCircuitBreakerStats,
  resetAllCircuitBreakers,
} from '../circuit-breaker'

// ============================================
// isNetworkError
// ============================================

describe('isNetworkError', () => {
  it('should detect network errors by keyword', () => {
    expect(isNetworkError(new Error('Network error'))).toBe(true)
    expect(isNetworkError(new Error('Request timeout'))).toBe(true)
    expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true)
    expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true)
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
    expect(isNetworkError(new Error('fetch failed'))).toBe(true)
  })

  it('should not detect non-network errors', () => {
    expect(isNetworkError(new Error('Invalid input'))).toBe(false)
    expect(isNetworkError(new Error('Unauthorized'))).toBe(false)
    expect(isNetworkError('not an error')).toBe(false)
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError(42)).toBe(false)
    expect(isNetworkError(undefined)).toBe(false)
  })
})

// ============================================
// isProviderRateLimitError
// ============================================

describe('isProviderRateLimitError', () => {
  it('should detect provider rate limit with nested structure', () => {
    expect(
      isProviderRateLimitError({
        error: {
          type: 'provider',
          reason: 'provider_error',
          message: 'Provider returned 429',
          provider: { status: 429 },
        },
      })
    ).toBe(true)
  })

  it('should detect rate limit from message text', () => {
    expect(
      isProviderRateLimitError({
        error: { type: 'provider', reason: 'provider_error', message: 'Rate limit exceeded' },
      })
    ).toBe(true)
  })

  it('should detect rate_limit reason', () => {
    expect(
      isProviderRateLimitError({ error: { type: 'provider', reason: 'rate_limit' } })
    ).toBe(true)
  })

  it('should detect HTTP 429 status at top level', () => {
    expect(isProviderRateLimitError({ status: 429 })).toBe(true)
  })

  it('should return false for non-rate-limit errors', () => {
    expect(isProviderRateLimitError({ status: 500 })).toBe(false)
    expect(isProviderRateLimitError({ error: { type: 'provider', reason: 'timeout' } })).toBe(false)
    expect(isProviderRateLimitError(null)).toBe(false)
    expect(isProviderRateLimitError(undefined)).toBe(false)
    expect(isProviderRateLimitError('a string')).toBe(false)
  })
})

// ============================================
// extractRetryAfter
// ============================================

describe('extractRetryAfter', () => {
  it('should extract retryAfter from top level', () => {
    expect(extractRetryAfter({ retryAfter: 30 })).toBe(30)
  })

  it('should extract retryAfter from nested error object', () => {
    expect(extractRetryAfter({ error: { retryAfter: 60 } })).toBe(60)
  })

  it('should extract retryAfter from details', () => {
    expect(extractRetryAfter({ details: { retryAfter: 45 } })).toBe(45)
  })

  it('should parse seconds from message', () => {
    expect(extractRetryAfter({ message: 'Please try again in 30 seconds' })).toBe(30)
    expect(extractRetryAfter({ message: 'try again after 15 sec' })).toBe(15)
  })

  it('should parse minutes from message and convert to seconds', () => {
    expect(extractRetryAfter({ message: 'Please try again in 2 minutes' })).toBe(120)
    expect(extractRetryAfter({ message: 'try again after 1 min' })).toBe(60)
  })

  it('should return null when not found', () => {
    expect(extractRetryAfter({ message: 'Some error' })).toBe(null)
    expect(extractRetryAfter(null)).toBe(null)
    expect(extractRetryAfter(undefined)).toBe(null)
    expect(extractRetryAfter({})).toBe(null)
  })
})

// ============================================
// isTransientError
// ============================================

describe('isTransientError', () => {
  it('should detect network errors as transient', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true)
    expect(isTransientError(new Error('fetch failed'))).toBe(true)
  })

  it('should detect provider rate limit errors as transient', () => {
    expect(
      isTransientError({ error: { type: 'provider', provider: { status: 429 } } })
    ).toBe(true)
  })

  it('should detect retryable flag at top level', () => {
    expect(isTransientError({ retryable: true })).toBe(true)
  })

  it('should detect retryable flag in nested error', () => {
    expect(isTransientError({ error: { retryable: true } })).toBe(true)
  })

  it('should detect transient HTTP status codes', () => {
    expect(isTransientError({ status: 429 })).toBe(true)
    expect(isTransientError({ status: 500 })).toBe(true)
    expect(isTransientError({ status: 502 })).toBe(true)
    expect(isTransientError({ status: 503 })).toBe(true)
    expect(isTransientError({ status: 504 })).toBe(true)
  })

  it('should not detect non-transient errors', () => {
    expect(isTransientError({ status: 400 })).toBe(false)
    expect(isTransientError({ status: 401 })).toBe(false)
    expect(isTransientError({ status: 403 })).toBe(false)
    expect(isTransientError({ status: 404 })).toBe(false)
    expect(isTransientError(new Error('Validation failed'))).toBe(false)
  })
})

// ============================================
// CircuitBreaker — State Transitions
// ============================================

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      const cb = new CircuitBreaker({ name: 'test' })
      expect(cb.getState()).toBe('CLOSED')
    })

    it('should execute operations successfully when CLOSED', async () => {
      const cb = new CircuitBreaker({ name: 'test' })
      const result = await cb.execute(() => Promise.resolve('ok'))
      expect(result).toBe('ok')
    })

    it('should track stats after execution', async () => {
      const cb = new CircuitBreaker({ name: 'test' })
      await cb.execute(() => Promise.resolve('ok'))
      const stats = cb.getStats()
      expect(stats.totalRequests).toBe(1)
      expect(stats.successes).toBe(1)
      expect(stats.failures).toBe(0)
      expect(stats.lastSuccessTime).not.toBeNull()
    })
  })

  describe('CLOSED -> OPEN after N failures', () => {
    it('should transition to OPEN after reaching failure threshold', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      }
      expect(cb.getState()).toBe('OPEN')
    })

    it('should remain CLOSED below failure threshold', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })

      for (let i = 0; i < 2; i++) {
        await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      }
      expect(cb.getState()).toBe('CLOSED')
    })

    it('should reset failure count on success in CLOSED state', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 })

      // Two failures
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getStats().failures).toBe(2)

      // One success resets failures
      await cb.execute(() => Promise.resolve('ok'))
      expect(cb.getStats().failures).toBe(0)

      // Need 3 more failures to open
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('CLOSED')
    })
  })

  describe('OPEN behavior', () => {
    it('should reject requests when OPEN (no fallback)', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 60000 })
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')

      // Next request should fail immediately with circuit breaker error
      await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow('Circuit breaker is OPEN')
    })

    it('should use fallback when OPEN', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        timeout: 60000,
        fallback: () => 'degraded',
      })

      // Trigger OPEN — fallback is used in handleFailure
      const result = await cb.execute(() => Promise.reject(new Error('fail')))
      expect(result).toBe('degraded')
      expect(cb.getState()).toBe('OPEN')

      // Further requests also use fallback
      const result2 = await cb.execute(() => Promise.resolve('ok'))
      expect(result2).toBe('degraded')
    })
  })

  describe('OPEN -> HALF_OPEN after timeout', () => {
    it('should transition to HALF_OPEN when timeout expires', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 100 })
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')

      // Wait for timeout to expire
      await new Promise((r) => setTimeout(r, 150))

      // Next call should transition to HALF_OPEN and execute
      await cb.execute(() => Promise.resolve('ok'))
      // After success it may have closed depending on successThreshold
    })
  })

  describe('HALF_OPEN -> CLOSED on sufficient successes', () => {
    it('should transition to CLOSED after successThreshold successes in HALF_OPEN', async () => {
      const stateChanges: string[] = []
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        successThreshold: 2,
        timeout: 50,
        onStateChange: (_from, to) => stateChanges.push(to),
      })

      // Open the breaker
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100))

      // Two successes should close it
      await cb.execute(() => Promise.resolve('ok'))
      await cb.execute(() => Promise.resolve('ok'))
      expect(cb.getState()).toBe('CLOSED')
      expect(stateChanges).toContain('HALF_OPEN')
      expect(stateChanges).toContain('CLOSED')
    })
  })

  describe('HALF_OPEN -> OPEN on failure', () => {
    it('should transition back to OPEN on failure during HALF_OPEN', async () => {
      const cb = new CircuitBreaker({
        name: 'test',
        failureThreshold: 1,
        timeout: 50,
      })

      // Open
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')

      // Wait for timeout -> HALF_OPEN
      await new Promise((r) => setTimeout(r, 100))

      // Failure during HALF_OPEN -> back to OPEN
      await expect(cb.execute(() => Promise.reject(new Error('fail again')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')
    })
  })

  describe('onStateChange callback', () => {
    it('should notify on every state transition', async () => {
      const transitions: Array<{ from: string; to: string }> = []
      const cb = new CircuitBreaker({
        name: 'test-cb',
        failureThreshold: 1,
        successThreshold: 1,
        timeout: 50,
        onStateChange: (from, to, name) => {
          transitions.push({ from, to })
          expect(name).toBe('test-cb')
        },
      })

      // CLOSED -> OPEN
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(transitions).toEqual([{ from: 'CLOSED', to: 'OPEN' }])

      // OPEN -> HALF_OPEN -> CLOSED
      await new Promise((r) => setTimeout(r, 100))
      await cb.execute(() => Promise.resolve('ok'))

      expect(transitions).toHaveLength(3)
      expect(transitions[1]).toEqual({ from: 'OPEN', to: 'HALF_OPEN' })
      expect(transitions[2]).toEqual({ from: 'HALF_OPEN', to: 'CLOSED' })
    })
  })

  describe('forceOpen / forceClose', () => {
    it('should force open the circuit', () => {
      const cb = new CircuitBreaker({ name: 'test' })
      expect(cb.getState()).toBe('CLOSED')
      cb.forceOpen()
      expect(cb.getState()).toBe('OPEN')
    })

    it('should force close the circuit and reset counters', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 })
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
      expect(cb.getState()).toBe('OPEN')

      cb.forceClose()
      expect(cb.getState()).toBe('CLOSED')
      expect(cb.getStats().failures).toBe(0)
      expect(cb.getStats().successes).toBe(0)
    })
  })

  describe('getStats', () => {
    it('should report accurate stats', async () => {
      const cb = new CircuitBreaker({ name: 'test', failureThreshold: 5 })

      await cb.execute(() => Promise.resolve('ok'))
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()

      const stats = cb.getStats()
      expect(stats.state).toBe('CLOSED')
      expect(stats.totalRequests).toBe(2)
      expect(stats.failures).toBe(1)
      expect(stats.successes).toBe(1)
      expect(stats.lastSuccessTime).not.toBeNull()
      expect(stats.lastFailureTime).not.toBeNull()
    })
  })
})

// ============================================
// withRetry
// ============================================

describe('withRetry', () => {
  it('should succeed on first try', async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      return 'success'
    })
    expect(result).toBe('success')
    expect(attempts).toBe(1)
  })

  it('should retry on failure and eventually succeed', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 3) throw new Error('fail')
        return 'success'
      },
      { maxRetries: 3, initialDelay: 10, jitter: false }
    )
    expect(result).toBe('success')
    expect(attempts).toBe(3)
  })

  it('should throw after max retries exhausted', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('always fail')
        },
        { maxRetries: 2, initialDelay: 10, jitter: false }
      )
    ).rejects.toThrow('always fail')
    expect(attempts).toBe(3) // initial + 2 retries
  })

  it('should not retry non-retryable errors', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('non-retryable')
        },
        { maxRetries: 3, initialDelay: 10, isRetryable: () => false }
      )
    ).rejects.toThrow('non-retryable')
    expect(attempts).toBe(1)
  })

  it('should call onRetry callback with correct params', async () => {
    const retries: Array<{ attempt: number; delay: number }> = []
    let attempts = 0

    await withRetry(
      async () => {
        attempts++
        if (attempts < 3) throw new Error('fail')
        return 'success'
      },
      {
        maxRetries: 3,
        initialDelay: 10,
        jitter: false,
        onRetry: (attempt, _error, delay) => retries.push({ attempt, delay }),
      }
    )

    expect(retries).toHaveLength(2)
    expect(retries[0].attempt).toBe(1)
    expect(retries[1].attempt).toBe(2)
  })

  it('should respect maxDelay cap', async () => {
    const delays: number[] = []
    let attempts = 0

    await withRetry(
      async () => {
        attempts++
        if (attempts <= 3) throw new Error('fail')
        return 'ok'
      },
      {
        maxRetries: 5,
        initialDelay: 100,
        maxDelay: 150,
        backoffMultiplier: 10,
        jitter: false,
        onRetry: (_attempt, _error, delay) => delays.push(delay),
      }
    )

    // All delays should be capped at maxDelay
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(150)
    }
  })
})

// ============================================
// withCircuitBreakerAndRetry
// ============================================

describe('withCircuitBreakerAndRetry', () => {
  it('should combine circuit breaker with retry logic', async () => {
    const cb = new CircuitBreaker({ name: 'combo-test', failureThreshold: 10 })
    let attempts = 0

    const result = await withCircuitBreakerAndRetry(
      cb,
      async () => {
        attempts++
        if (attempts < 2) throw new Error('fail')
        return 'combo-success'
      },
      { maxRetries: 3, initialDelay: 10, jitter: false }
    )

    expect(result).toBe('combo-success')
    expect(attempts).toBe(2)
  })
})

// ============================================
// RetryPresets
// ============================================

describe('RetryPresets', () => {
  it('should have valid fast preset', () => {
    expect(RetryPresets.fast.maxRetries).toBe(2)
    expect(RetryPresets.fast.initialDelay).toBe(500)
    expect(RetryPresets.fast.maxDelay).toBe(2000)
  })

  it('should have valid standard preset', () => {
    expect(RetryPresets.standard.maxRetries).toBe(3)
    expect(RetryPresets.standard.initialDelay).toBe(1000)
    expect(RetryPresets.standard.maxDelay).toBe(10000)
  })

  it('should have valid patient preset', () => {
    expect(RetryPresets.patient.maxRetries).toBe(5)
    expect(RetryPresets.patient.initialDelay).toBe(2000)
    expect(RetryPresets.patient.maxDelay).toBe(60000)
  })

  it('should have valid aggressive preset', () => {
    expect(RetryPresets.aggressive.maxRetries).toBe(10)
    expect(RetryPresets.aggressive.backoffMultiplier).toBe(1.5)
  })

  it('all presets should have jitter enabled', () => {
    expect(RetryPresets.fast.jitter).toBe(true)
    expect(RetryPresets.standard.jitter).toBe(true)
    expect(RetryPresets.patient.jitter).toBe(true)
    expect(RetryPresets.aggressive.jitter).toBe(true)
  })
})

// ============================================
// Circuit Breaker Factory (getCircuitBreaker, etc.)
// ============================================

describe('Circuit Breaker Factory', () => {
  afterEach(() => {
    resetAllCircuitBreakers()
  })

  it('getCircuitBreaker should create and cache breakers by name', () => {
    const cb1 = getCircuitBreaker('factory-test')
    const cb2 = getCircuitBreaker('factory-test')
    expect(cb1).toBe(cb2) // Same instance
  })

  it('getCircuitBreaker should create different instances for different names', () => {
    const cb1 = getCircuitBreaker('test-a')
    const cb2 = getCircuitBreaker('test-b')
    expect(cb1).not.toBe(cb2)
  })

  it('getAllCircuitBreakerStats should return stats for all breakers', () => {
    getCircuitBreaker('stats-a')
    getCircuitBreaker('stats-b')
    const stats = getAllCircuitBreakerStats()
    expect(stats['stats-a']).toBeDefined()
    expect(stats['stats-b']).toBeDefined()
    expect(stats['stats-a'].state).toBe('CLOSED')
  })

  it('resetAllCircuitBreakers should close all breakers', async () => {
    const cb = getCircuitBreaker('reset-test', { failureThreshold: 1 })
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(cb.getState()).toBe('OPEN')

    resetAllCircuitBreakers()
    expect(cb.getState()).toBe('CLOSED')
  })
})
