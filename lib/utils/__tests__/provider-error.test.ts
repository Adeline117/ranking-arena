/**
 * Tests for provider error handling utilities
 */

import {
  parseProviderError,
  isProviderRateLimitError,
  isRetryableProviderError,
  toUserFriendlyError,
  formatWaitTime,
} from '../provider-error'

describe('parseProviderError', () => {
  it('should parse a standard provider rate limit error', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        message: 'Provider returned 429',
        retryable: true,
        provider: {
          status: 429,
          body: 'rate_limit_error',
        },
      },
    }

    const result = parseProviderError(error)

    expect(result.isProviderError).toBe(true)
    expect(result.isRateLimited).toBe(true)
    expect(result.isRetryable).toBe(true)
    expect(result.message).toBe('Provider returned 429')
  })

  it('should parse a rate limit error from message', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        message: 'Rate limit exceeded for this organization',
        retryable: true,
      },
    }

    const result = parseProviderError(error)

    expect(result.isProviderError).toBe(true)
    expect(result.isRateLimited).toBe(true)
    expect(result.isRetryable).toBe(true)
  })

  it('should extract retryAfter from message', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
        message: 'Rate limit exceeded. Please try again in 30 seconds.',
      },
    }

    const result = parseProviderError(error)

    expect(result.isRateLimited).toBe(true)
    expect(result.retryAfterSeconds).toBe(30)
  })

  it('should use explicit retryAfter field', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
        message: 'Rate limit exceeded',
        retryAfter: 60,
      },
    }

    const result = parseProviderError(error)

    expect(result.retryAfterSeconds).toBe(60)
  })

  it('should handle HTTP 429 status', () => {
    const error = {
      status: 429,
      message: 'Too many requests',
    }

    const result = parseProviderError(error)

    expect(result.isProviderError).toBe(true)
    expect(result.isRateLimited).toBe(true)
    expect(result.isRetryable).toBe(true)
  })

  it('should handle non-provider errors', () => {
    const error = {
      code: 'NOT_FOUND',
      message: 'Resource not found',
    }

    const result = parseProviderError(error)

    expect(result.isProviderError).toBe(false)
    expect(result.isRateLimited).toBe(false)
    expect(result.isRetryable).toBe(false)
  })

  it('should handle null and undefined', () => {
    expect(parseProviderError(null).isProviderError).toBe(false)
    expect(parseProviderError(undefined).isProviderError).toBe(false)
  })

  it('should handle string errors', () => {
    const result = parseProviderError('Something went wrong')

    expect(result.isProviderError).toBe(false)
    expect(result.message).toBe('Something went wrong')
  })
})

describe('isProviderRateLimitError', () => {
  it('should return true for provider rate limit errors', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        provider: { status: 429 },
      },
    }

    expect(isProviderRateLimitError(error)).toBe(true)
  })

  it('should return false for non-rate-limit errors', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        provider: { status: 500 },
      },
    }

    expect(isProviderRateLimitError(error)).toBe(false)
  })
})

describe('isRetryableProviderError', () => {
  it('should return true for rate limit errors', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
      },
    }

    expect(isRetryableProviderError(error)).toBe(true)
  })

  it('should return true for 500 errors', () => {
    const error = {
      status: 500,
      message: 'Internal server error',
    }

    expect(isRetryableProviderError(error)).toBe(true)
  })

  it('should return false for 400 errors', () => {
    const error = {
      status: 400,
      message: 'Bad request',
    }

    expect(isRetryableProviderError(error)).toBe(false)
  })
})

describe('toUserFriendlyError', () => {
  it('should format rate limit error in Chinese', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
        message: 'Rate limit exceeded',
        retryAfter: 30,
      },
    }

    const result = toUserFriendlyError(error, 'zh')

    expect(result.title).toBe('请求频率超限')
    expect(result.retryable).toBe(true)
    expect(result.retryAfterSeconds).toBe(30)
  })

  it('should format rate limit error in English', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'rate_limit',
        message: 'Rate limit exceeded',
        retryAfter: 30,
      },
    }

    const result = toUserFriendlyError(error, 'en')

    expect(result.title).toBe('Rate Limit Exceeded')
    expect(result.retryable).toBe(true)
  })

  it('should handle provider errors without rate limit', () => {
    const error = {
      error: {
        type: 'provider',
        reason: 'provider_error',
        message: 'Service unavailable',
        retryable: true,
      },
    }

    const result = toUserFriendlyError(error, 'zh')

    expect(result.title).toBe('服务暂时不可用')
    expect(result.retryable).toBe(true)
  })

  it('should handle non-provider errors', () => {
    const error = {
      message: 'Something went wrong',
    }

    const result = toUserFriendlyError(error, 'zh')

    expect(result.title).toBe('操作失败')
    expect(result.retryable).toBe(false)
  })
})

describe('formatWaitTime', () => {
  it('should format seconds in Chinese', () => {
    expect(formatWaitTime(30, 'zh')).toBe('30 秒')
  })

  it('should format seconds in English', () => {
    expect(formatWaitTime(30, 'en')).toBe('30 seconds')
  })

  it('should format minutes in Chinese', () => {
    expect(formatWaitTime(90, 'zh')).toBe('2 分钟')
  })

  it('should format minutes in English', () => {
    expect(formatWaitTime(60, 'en')).toBe('1 minute')
    expect(formatWaitTime(120, 'en')).toBe('2 minutes')
  })
})
