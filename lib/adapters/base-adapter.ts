/**
 * Base Exchange Adapter
 * Provides common functionality for all exchange adapters
 */

import { logger } from '@/lib/logger'
import type {
  ExchangeAdapter,
  AdapterConfig,
  AdapterError,
  RateLimitInfo,
} from './types'

export abstract class BaseAdapter implements Partial<ExchangeAdapter> {
  abstract name: string
  abstract type: 'cex' | 'dex'

  protected config: Required<AdapterConfig>

  constructor(config: AdapterConfig = {}) {
    this.config = {
      apiKey: config.apiKey || '',
      apiSecret: config.apiSecret || '',
      baseUrl: config.baseUrl || '',
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
    }
  }

  /**
   * Make HTTP request with retry logic
   */
  protected async request<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= this.config.retries; attempt++) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout
        )

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}: ${response.statusText}`
          )
        }

        const data = await response.json()
        return data as T
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        if (attempt < this.config.retries) {
          const delay = Math.pow(2, attempt) * 1000 // Exponential backoff
          logger.warn(
            `[${this.name}] Request failed (attempt ${attempt}/${this.config.retries}), retrying in ${delay}ms...`,
            { url, error: lastError.message }
          )
          await this.sleep(delay)
        }
      }
    }

    logger.error(`[${this.name}] Request failed after ${this.config.retries} attempts`, {
      url,
      error: lastError?.message,
    })

    throw this.createError(
      `Request failed: ${lastError?.message}`,
      'REQUEST_FAILED',
      lastError
    )
  }

  /**
   * Sleep utility
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Create standardized error
   */
  protected createError(
    message: string,
    code: string,
    originalError?: Error
  ): AdapterError {
    return {
      name: 'AdapterError',
      message,
      code,
      platform: this.name,
      originalError,
    } as AdapterError
  }

  /**
   * Validate required config
   */
  protected validateConfig(requiredFields: (keyof AdapterConfig)[]): void {
    for (const field of requiredFields) {
      if (!this.config[field]) {
        throw this.createError(
          `Missing required config: ${field}`,
          'MISSING_CONFIG'
        )
      }
    }
  }

  /**
   * Health check - should be overridden by subclasses
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Default implementation - subclasses should override
      return true
    } catch (error) {
      logger.error(`[${this.name}] Health check failed`, { error })
      return false
    }
  }

  /**
   * Get rate limit info - should be overridden by subclasses
   */
  getRateLimitInfo(): RateLimitInfo {
    return {
      limit: 100,
      period: 60,
    }
  }
}
