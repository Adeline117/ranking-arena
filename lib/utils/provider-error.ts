/**
 * Provider Error Handling Utility
 * Handles rate limit and other errors from external API providers (e.g., OpenAI, Anthropic)
 */

import { RetryOptions } from './circuit-breaker'

// ============================================
// Provider Error Types
// ============================================

export interface ProviderErrorDetails {
  status: number
  body?: string | Record<string, unknown>
}

export interface ProviderError {
  type: 'provider'
  reason: 'provider_error' | 'rate_limit' | 'timeout' | 'network_error'
  message: string
  retryable: boolean
  provider?: ProviderErrorDetails
  retryAfter?: number // seconds until retry is allowed
}

export interface ParsedProviderError {
  isProviderError: boolean
  isRateLimited: boolean
  isRetryable: boolean
  retryAfterSeconds: number | null
  message: string
  originalError: unknown
}

// ============================================
// Error Detection & Parsing
// ============================================

/**
 * Parse a provider error response
 * Handles formats from various AI providers (OpenAI, Anthropic, etc.)
 */
export function parseProviderError(error: unknown): ParsedProviderError {
  const defaultResult: ParsedProviderError = {
    isProviderError: false,
    isRateLimited: false,
    isRetryable: false,
    retryAfterSeconds: null,
    message: 'Unknown error',
    originalError: error,
  }

  if (!error || typeof error !== 'object') {
    return { ...defaultResult, message: String(error) }
  }

  const errorObj = error as Record<string, unknown>

  // Handle nested error structure: { error: { type: 'provider', ... } }
  const providerData = (errorObj.error as Record<string, unknown>) || errorObj

  // Check if this is a provider error
  if (providerData.type === 'provider' || providerData.reason === 'provider_error') {
    const isRateLimited =
      providerData.reason === 'rate_limit' ||
      (providerData.message as string)?.toLowerCase().includes('rate limit') ||
      (providerData.provider as ProviderErrorDetails)?.status === 429

    // Extract retry-after from provider response
    let retryAfterSeconds: number | null = null
    if (typeof providerData.retryAfter === 'number') {
      retryAfterSeconds = providerData.retryAfter
    } else {
      // Try to parse from message (some providers include it in the message)
      const message = String(providerData.message || '')
      const retryMatch = message.match(/try again (?:in |after )?(\d+)\s*(?:second|sec|s)/i)
      if (retryMatch) {
        retryAfterSeconds = parseInt(retryMatch[1], 10)
      }
    }

    return {
      isProviderError: true,
      isRateLimited,
      isRetryable: Boolean(providerData.retryable) || isRateLimited,
      retryAfterSeconds,
      message: String(providerData.message || 'Provider error'),
      originalError: error,
    }
  }

  // Handle standard HTTP error responses
  if ('status' in errorObj && typeof errorObj.status === 'number') {
    const status = errorObj.status
    return {
      isProviderError: true,
      isRateLimited: status === 429,
      isRetryable: [429, 500, 502, 503, 504].includes(status),
      retryAfterSeconds: null,
      message: String(errorObj.message || `HTTP ${status} error`),
      originalError: error,
    }
  }

  return { ...defaultResult, message: String(errorObj.message || 'Unknown error') }
}

/**
 * Check if an error is a rate limit error from a provider
 */
export function isProviderRateLimitError(error: unknown): boolean {
  const parsed = parseProviderError(error)
  return parsed.isProviderError && parsed.isRateLimited
}

/**
 * Check if an error is retryable (rate limit or transient error)
 */
export function isRetryableProviderError(error: unknown): boolean {
  const parsed = parseProviderError(error)
  return parsed.isRetryable
}

// ============================================
// Retry Logic for Provider Errors
// ============================================

export interface ProviderRetryOptions extends Omit<RetryOptions, 'isRetryable'> {
  /** Callback when rate limited */
  onRateLimited?: (retryAfterSeconds: number | null, attempt: number) => void
  /** Maximum wait time for rate limit (ms) - defaults to 60000 */
  maxRateLimitWait?: number
  /** Minimum delay between retries (ms) - defaults to 1000 */
  minDelay?: number
}

/**
 * Execute an operation with automatic retry for provider rate limits
 * Uses exponential backoff with jitter, respecting Retry-After headers
 */
export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 2000,
    maxDelay = 60000,
    backoffMultiplier = 2,
    jitter = true,
    onRetry,
    onRateLimited,
    maxRateLimitWait = 60000,
    minDelay = 1000,
  } = options

  let lastError: unknown
  let attempt = 0

  while (attempt <= maxRetries) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const parsed = parseProviderError(error)

      // Check if we should retry
      if (attempt >= maxRetries || !parsed.isRetryable) {
        throw error
      }

      // Calculate delay
      let delay: number

      if (parsed.isRateLimited && parsed.retryAfterSeconds !== null) {
        // Use the provider's retry-after value
        delay = Math.min(parsed.retryAfterSeconds * 1000, maxRateLimitWait)
        onRateLimited?.(parsed.retryAfterSeconds, attempt + 1)
      } else {
        // Use exponential backoff
        delay = Math.min(initialDelay * Math.pow(backoffMultiplier, attempt), maxDelay)
      }

      // Add jitter (0.5 to 1.0 of the delay)
      if (jitter) {
        delay = delay * (0.5 + Math.random() * 0.5)
      }

      // Ensure minimum delay
      delay = Math.max(delay, minDelay)

      onRetry?.(attempt + 1, error, delay)

      console.log(
        `[ProviderRetry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${parsed.message}. ` +
        `Retrying in ${Math.round(delay)}ms...`
      )

      await sleep(delay)
      attempt++
    }
  }

  throw lastError
}

/**
 * Create a wrapped function that automatically retries on provider errors
 */
export function createRetryableProviderCall<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: ProviderRetryOptions
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withProviderRetry(() => fn(...args), options)
}

// ============================================
// Provider Rate Limit Presets
// ============================================

export const ProviderRetryPresets = {
  /** For AI/LLM API calls - patient with longer waits */
  aiProvider: {
    maxRetries: 3,
    initialDelay: 2000,
    maxDelay: 120000, // 2 minutes max
    maxRateLimitWait: 120000,
    backoffMultiplier: 2,
    jitter: true,
  } as ProviderRetryOptions,

  /** For quick API calls with short timeout */
  quick: {
    maxRetries: 2,
    initialDelay: 1000,
    maxDelay: 10000,
    maxRateLimitWait: 10000,
    backoffMultiplier: 2,
    jitter: true,
  } as ProviderRetryOptions,

  /** For critical operations - more retries */
  critical: {
    maxRetries: 5,
    initialDelay: 2000,
    maxDelay: 180000, // 3 minutes max
    maxRateLimitWait: 180000,
    backoffMultiplier: 1.5,
    jitter: true,
  } as ProviderRetryOptions,
}

// ============================================
// User-Friendly Error Messages
// ============================================

export interface UserFriendlyError {
  title: string
  message: string
  action?: string
  retryable: boolean
  retryAfterSeconds?: number
}

/**
 * Convert a provider error to a user-friendly message
 */
export function toUserFriendlyError(error: unknown, locale: 'zh' | 'en' = 'zh'): UserFriendlyError {
  const parsed = parseProviderError(error)

  if (parsed.isRateLimited) {
    const retryText = parsed.retryAfterSeconds
      ? locale === 'zh'
        ? `请等待 ${parsed.retryAfterSeconds} 秒后重试`
        : `Please wait ${parsed.retryAfterSeconds} seconds before retrying`
      : locale === 'zh'
        ? '请稍后再试'
        : 'Please try again later'

    return {
      title: locale === 'zh' ? '请求频率超限' : 'Rate Limit Exceeded',
      message: locale === 'zh'
        ? '服务请求过于频繁，已触发限流保护。'
        : 'Too many requests. The service has been temporarily rate limited.',
      action: retryText,
      retryable: true,
      retryAfterSeconds: parsed.retryAfterSeconds || undefined,
    }
  }

  if (parsed.isProviderError) {
    return {
      title: locale === 'zh' ? '服务暂时不可用' : 'Service Temporarily Unavailable',
      message: locale === 'zh'
        ? '外部服务出现问题，我们正在处理中。'
        : 'An external service is experiencing issues. We are working on it.',
      action: locale === 'zh' ? '请稍后重试' : 'Please try again later',
      retryable: parsed.isRetryable,
    }
  }

  return {
    title: locale === 'zh' ? '操作失败' : 'Operation Failed',
    message: parsed.message,
    retryable: false,
  }
}

// ============================================
// Utilities
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Format remaining wait time for display
 */
export function formatWaitTime(seconds: number, locale: 'zh' | 'en' = 'zh'): string {
  if (seconds < 60) {
    return locale === 'zh' ? `${seconds} 秒` : `${seconds} seconds`
  }
  const minutes = Math.ceil(seconds / 60)
  return locale === 'zh' ? `${minutes} 分钟` : `${minutes} minute${minutes > 1 ? 's' : ''}`
}
