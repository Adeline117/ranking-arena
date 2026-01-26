/**
 * HTTP Client Singleton
 *
 * Provides a shared HTTP client with:
 * - Exponential backoff retry (with max cap)
 * - User-Agent rotation
 * - Timeout control
 * - Request metrics tracking
 */

import { createLogger } from '../utils/logger'

const httpLogger = createLogger('HTTP')

// ============================================
// Types
// ============================================

export interface HttpClientConfig {
  /** Base timeout in milliseconds */
  timeout: number
  /** Max retries for transient errors */
  maxRetries: number
  /** Base delay for retry backoff in ms */
  retryBaseDelay: number
  /** Max delay cap for retry backoff in ms */
  retryMaxDelay: number
  /** Whether to add jitter to retry delays */
  jitter: boolean
}

export interface RequestMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  totalLatencyMs: number
  avgLatencyMs: number
  lastRequestAt: Date | null
}

export interface HttpRequestOptions extends RequestInit {
  /** Override timeout for this request */
  timeout?: number
  /** Override max retries for this request */
  maxRetries?: number
  /** Skip retry logic */
  noRetry?: boolean
  /** Custom retry condition */
  shouldRetry?: (error: Error, attempt: number) => boolean
}

// ============================================
// Constants
// ============================================

const DEFAULT_CONFIG: HttpClientConfig = {
  timeout: 30000,
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 30000,
  jitter: true,
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]

// ============================================
// HTTP Client Class
// ============================================

export class HttpClient {
  private config: HttpClientConfig
  private metrics: RequestMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    lastRequestAt: null,
  }
  private userAgentIndex = 0

  constructor(config?: Partial<HttpClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Make an HTTP request with retry and timeout
   */
  async request<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const {
      timeout = this.config.timeout,
      maxRetries = this.config.maxRetries,
      noRetry = false,
      shouldRetry,
      ...fetchOptions
    } = options

    const startTime = Date.now()
    this.metrics.totalRequests++
    this.metrics.lastRequestAt = new Date()

    let lastError: Error | null = null
    const maxAttempts = noRetry ? 1 : maxRetries + 1

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.executeRequest<T>(url, fetchOptions, timeout)
        this.recordSuccess(Date.now() - startTime)
        return response
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Check if we should retry
        const isRetryable = shouldRetry
          ? shouldRetry(lastError, attempt)
          : this.isRetryableError(lastError)

        if (attempt < maxAttempts - 1 && isRetryable) {
          const delay = this.calculateBackoff(attempt)
          httpLogger.warn(
            `Request to ${url} failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${Math.round(delay)}ms: ${lastError.message}`
          )
          await this.sleep(delay)
        }
      }
    }

    this.recordFailure()
    throw lastError || new Error('Request failed after max retries')
  }

  /**
   * Execute a single request with timeout
   */
  private async executeRequest<T>(
    url: string,
    options: RequestInit,
    timeout: number
  ): Promise<T> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': this.getNextUserAgent(),
          Accept: 'application/json',
          ...options.headers,
        },
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new HttpError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorText
        )
      }

      return (await response.json()) as T
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Get a rotating User-Agent
   */
  private getNextUserAgent(): string {
    const ua = USER_AGENTS[this.userAgentIndex]
    this.userAgentIndex = (this.userAgentIndex + 1) % USER_AGENTS.length
    return ua
  }

  /**
   * Calculate backoff delay with exponential growth and cap
   */
  private calculateBackoff(attempt: number): number {
    let delay = this.config.retryBaseDelay * Math.pow(2, attempt)
    delay = Math.min(delay, this.config.retryMaxDelay)

    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5)
    }

    return delay
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: Error): boolean {
    // Network errors
    if (error.name === 'AbortError') return true
    if (error.message.includes('fetch failed')) return true
    if (error.message.includes('ECONNREFUSED')) return true
    if (error.message.includes('ETIMEDOUT')) return true
    if (error.message.includes('ENOTFOUND')) return true

    // HTTP errors
    if (error instanceof HttpError) {
      return [408, 429, 500, 502, 503, 504].includes(error.status)
    }

    return false
  }

  /**
   * Record a successful request
   */
  private recordSuccess(latencyMs: number): void {
    this.metrics.successfulRequests++
    this.metrics.totalLatencyMs += latencyMs
    this.metrics.avgLatencyMs =
      this.metrics.totalLatencyMs / this.metrics.successfulRequests
  }

  /**
   * Record a failed request
   */
  private recordFailure(): void {
    this.metrics.failedRequests++
  }

  /**
   * Get current metrics
   */
  getMetrics(): RequestMetrics {
    return { ...this.metrics }
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      lastRequestAt: null,
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ============================================
// HTTP Error Class
// ============================================

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500
  }

  get isServerError(): boolean {
    return this.status >= 500
  }

  get isRateLimited(): boolean {
    return this.status === 429
  }
}

// ============================================
// Singleton Instance
// ============================================

let httpClientInstance: HttpClient | null = null

/**
 * Get the shared HTTP client instance
 */
export function getHttpClient(config?: Partial<HttpClientConfig>): HttpClient {
  if (!httpClientInstance) {
    httpClientInstance = new HttpClient(config)
  }
  return httpClientInstance
}

/**
 * Create a new HTTP client with custom config (not singleton)
 */
export function createHttpClient(config?: Partial<HttpClientConfig>): HttpClient {
  return new HttpClient(config)
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Simple GET request using shared client
 */
export async function httpGet<T>(url: string, options?: HttpRequestOptions): Promise<T> {
  return getHttpClient().request<T>(url, { ...options, method: 'GET' })
}

/**
 * Simple POST request using shared client
 */
export async function httpPost<T>(
  url: string,
  body: unknown,
  options?: HttpRequestOptions
): Promise<T> {
  return getHttpClient().request<T>(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
}
