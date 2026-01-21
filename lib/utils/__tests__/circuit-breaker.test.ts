/**
 * Tests for circuit breaker and retry utilities
 */

import {
  CircuitBreaker,
  withRetry,
  isNetworkError,
  isProviderRateLimitError,
  extractRetryAfter,
  isTransientError,
  RetryPresets,
} from '../circuit-breaker'

describe('isNetworkError', () => {
  it('should detect network errors', () => {
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
  })
})

describe('isProviderRateLimitError', () => {
  it('should detect provider rate limit errors with nested structure', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        message: 'Provider returned 429',
        provider: { status: 429 },
      },
    }

    expect(isProviderRateLimitError(error)).toBe(true)
  })

  it('should detect rate limit from message', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        message: 'Rate limit exceeded',
      },
    }

    expect(isProviderRateLimitError(error)).toBe(true)
  })

  it('should detect rate_limit reason', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
      },
    }

    expect(isProviderRateLimitError(error)).toBe(true)
  })

  it('should detect HTTP 429 status', () => {
    expect(isProviderRateLimitError({ status: 429 })).toBe(true)
  })

  it('should return false for non-rate-limit errors', () => {
    expect(isProviderRateLimitError({ status: 500 })).toBe(false)
    expect(isProviderRateLimitError({ error: { type: 'provider', reason: 'timeout' } })).toBe(false)
    expect(isProviderRateLimitError(null)).toBe(false)
    expect(isProviderRateLimitError(undefined)).toBe(false)
  })
})

describe('extractRetryAfter', () => {
  it('should extract retryAfter from top level', () => {
    expect(extractRetryAfter({ retryAfter: 30 })).toBe(30)
  })

  it('should extract retryAfter from nested error', () => {
    expect(extractRetryAfter({ error: { retryAfter: 60 } })).toBe(60)
  })

  it('should extract retryAfter from details', () => {
    expect(extractRetryAfter({ details: { retryAfter: 45 } })).toBe(45)
  })

  it('should extract retryAfter from message (seconds)', () => {
    expect(extractRetryAfter({ message: 'Please try again in 30 seconds' })).toBe(30)
    expect(extractRetryAfter({ message: 'try again after 15 sec' })).toBe(15)
  })

  it('should extract retryAfter from message (minutes)', () => {
    expect(extractRetryAfter({ message: 'Please try again in 2 minutes' })).toBe(120)
    expect(extractRetryAfter({ message: 'try again after 1 min' })).toBe(60)
  })

  it('should return null when not found', () => {
    expect(extractRetryAfter({ message: 'Some error' })).toBe(null)
    expect(extractRetryAfter(null)).toBe(null)
    expect(extractRetryAfter(undefined)).toBe(null)
  })
})

describe('isTransientError', () => {
  it('should detect network errors', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true)
  })

  it('should detect provider rate limit errors', () => {
    expect(isTransientError({ error: { type: 'provider', provider: { status: 429 } } })).toBe(true)
  })

  it('should detect retryable flag', () => {
    expect(isTransientError({ retryable: true })).toBe(true)
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
  })
})

describe('CircuitBreaker', () => {
  it('should start in CLOSED state', () => {
    const breaker = new CircuitBreaker({ name: 'test' })
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('should execute operations successfully', async () => {
    const breaker = new CircuitBreaker({ name: 'test' })
    const result = await breaker.execute(() => Promise.resolve('success'))
    expect(result).toBe('success')
  })

  it('should open after failure threshold', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 2 })

    // First failure
    await expect(breaker.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(breaker.getState()).toBe('CLOSED')

    // Second failure - should open
    await expect(breaker.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow()
    expect(breaker.getState()).toBe('OPEN')
  })

  it('should use fallback when open', async () => {
    const breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      fallback: () => 'fallback',
    })

    // Trigger open state
    await expect(breaker.execute(() => Promise.reject(new Error('fail')))).resolves.toBe('fallback')

    // Should return fallback while open
    const result = await breaker.execute(() => Promise.resolve('success'))
    expect(result).toBe('fallback')
  })
})

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

  it('should retry on failure', async () => {
    let attempts = 0
    const result = await withRetry(
      async () => {
        attempts++
        if (attempts < 3) throw new Error('fail')
        return 'success'
      },
      { maxRetries: 3, initialDelay: 10 }
    )

    expect(result).toBe('success')
    expect(attempts).toBe(3)
  })

  it('should throw after max retries', async () => {
    let attempts = 0
    await expect(
      withRetry(
        async () => {
          attempts++
          throw new Error('always fail')
        },
        { maxRetries: 2, initialDelay: 10 }
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
        {
          maxRetries: 3,
          initialDelay: 10,
          isRetryable: () => false,
        }
      )
    ).rejects.toThrow('non-retryable')

    expect(attempts).toBe(1)
  })

  it('should call onRetry callback', async () => {
    const retries: number[] = []
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
        onRetry: (attempt) => retries.push(attempt),
      }
    )

    expect(retries).toEqual([1, 2])
  })
})

describe('RetryPresets', () => {
  it('should have valid fast preset', () => {
    expect(RetryPresets.fast.maxRetries).toBe(2)
    expect(RetryPresets.fast.initialDelay).toBe(500)
  })

  it('should have valid standard preset', () => {
    expect(RetryPresets.standard.maxRetries).toBe(3)
    expect(RetryPresets.standard.initialDelay).toBe(1000)
  })

  it('should have valid patient preset', () => {
    expect(RetryPresets.patient.maxRetries).toBe(5)
    expect(RetryPresets.patient.initialDelay).toBe(2000)
  })

  it('should have valid aggressive preset', () => {
    expect(RetryPresets.aggressive.maxRetries).toBe(10)
  })
})
