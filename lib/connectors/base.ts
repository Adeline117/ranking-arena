/**
 * Base Connector - Abstract base class for all platform connectors.
 *
 * Provides:
 * - HTTP request helpers with retry/backoff
 * - Rate limiting integration
 * - Circuit breaker pattern
 * - Quality flag generation
 * - Data provenance tracking
 * - Error handling patterns
 */

import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  QualityFlags,
  DataProvenance,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  PlatformCapabilities,
  SnapshotMetrics,
  RateLimiterConfig,
  GranularPlatform,
} from '../types/leaderboard'
import { exchangeLogger } from '../utils/logger'
import { PLATFORM_RATE_LIMITS } from '../types/leaderboard'
import type { PlatformConnector, ConnectorConfig, RateLimiter } from './types'
import { ConnectorError, DEFAULT_CONNECTOR_CONFIG } from './types'
export { ConnectorError, DEFAULT_CONNECTOR_CONFIG }

// ============================================
// Circuit Breaker (standalone, for legacy usage)
// ============================================

type CircuitState = 'closed' | 'open' | 'half_open'

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CircuitOpenError'
  }
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard to check if value is an Error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error
}

/**
 * Safely extract Error from unknown catch value
 */
export function toError(value: unknown): Error {
  if (isError(value)) return value
  if (typeof value === 'string') return new Error(value)
  if (value && typeof value === 'object' && 'message' in value) {
    return new Error(String((value as { message: unknown }).message))
  }
  return new Error(String(value))
}

class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private successCount = 0

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeout: number = 60_000,
    private readonly halfOpenMaxAttempts: number = 2
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half_open'
        this.successCount = 0
      } else {
        throw new CircuitOpenError(
          `Circuit is open. Retry after ${this.resetTimeout - (Date.now() - this.lastFailureTime)}ms`
        )
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++
      if (this.successCount >= this.halfOpenMaxAttempts) {
        this.state = 'closed'
        this.failureCount = 0
      }
    } else {
      this.failureCount = 0
    }
  }

  private onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open'
    }
  }

  getState(): CircuitState {
    return this.state
  }
}

// ============================================
// Legacy RateLimiter (inline, for BaseConnectorLegacy)
// ============================================

class InlineRateLimiter {
  private queue: Array<() => void> = []
  private running = 0
  private timestamps: number[] = []

  constructor(private config: RateLimiterConfig) {}

  async acquire(): Promise<void> {
    if (this.running >= this.config.max_concurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }

    const now = Date.now()
    this.timestamps = this.timestamps.filter((t) => now - t < this.config.window_ms)

    if (this.timestamps.length >= this.config.max_requests) {
      const waitUntil = this.timestamps[0] + this.config.window_ms
      await sleep(waitUntil - now)
    }

    const delay =
      this.config.min_delay_ms +
      Math.random() * (this.config.max_delay_ms - this.config.min_delay_ms)
    await sleep(delay)

    this.running++
    this.timestamps.push(Date.now())
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }
}

// ============================================
// Base Connector (New - HTTP-based)
// ============================================

/**
 * Abstract base class for platform connectors.
 * Subclasses must implement the core data-fetching methods.
 */
export abstract class BaseConnector implements PlatformConnector {
  abstract readonly platform: LeaderboardPlatform
  abstract readonly marketType: MarketType
  abstract readonly capabilities: PlatformCapabilities

  protected config: ConnectorConfig
  protected rateLimiter: RateLimiter | null = null

  constructor(config?: Partial<ConnectorConfig>) {
    this.config = { ...DEFAULT_CONNECTOR_CONFIG, ...config }
  }

  /** Set the rate limiter for this connector */
  setRateLimiter(limiter: RateLimiter): void {
    this.rateLimiter = limiter
  }

  // ============================================
  // Abstract methods (must be implemented by subclass)
  // ============================================

  abstract discoverLeaderboard(
    window: Window,
    limit?: number,
    offset?: number
  ): Promise<DiscoverResult>

  abstract fetchTraderProfile(traderKey: string): Promise<ProfileResult | null>

  abstract fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null>

  abstract fetchTimeseries(traderKey: string): Promise<TimeseriesResult>

  abstract normalize(raw: unknown): Record<string, unknown>

  // ============================================
  // HTTP Request Helpers
  // ============================================

  /**
   * Make an HTTP request with retry, backoff, and rate limiting.
   */
  protected async request<T>(url: string, options?: RequestInit): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      // Rate limiting
      if (this.rateLimiter) {
        if (this.rateLimiter.isCircuitOpen()) {
          throw new ConnectorError(
            'Circuit breaker is open, platform temporarily unavailable',
            this.platform,
            this.marketType,
            503,
            false
          )
        }
        await this.rateLimiter.acquire()
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.config.timeout)

        // Proxy support: rewrite URL through CF Worker if proxyUrl is configured
        let fetchUrl = url
        if (this.config.proxyUrl) {
          fetchUrl = `${this.config.proxyUrl}/proxy?url=${encodeURIComponent(url)}`
        }

        const response = await fetch(fetchUrl, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json',
            ...this.config.headers,
            ...options?.headers,
          },
        })

        clearTimeout(timeout)

        // WAF/CloudFlare detection: check content-type before parsing JSON
        const contentType = response.headers.get('content-type') || ''
        if (response.ok && !contentType.includes('application/json')) {
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `WAF/CloudFlare block detected: expected JSON but got ${contentType}`,
            this.platform,
            this.marketType,
            response.status,
            true // retryable — may succeed after backoff
          )
        }

        // Rate limited
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10)
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `Rate limited, retry after ${retryAfter}s`,
            this.platform,
            this.marketType,
            429,
            true,
            retryAfter
          )
        }

        // Server error
        if (response.status >= 500) {
          this.rateLimiter?.recordFailure()
          throw new ConnectorError(
            `Server error: ${response.status}`,
            this.platform,
            this.marketType,
            response.status
          )
        }

        // Client error (not retryable)
        if (response.status >= 400) {
          throw new ConnectorError(
            `Client error: ${response.status}`,
            this.platform,
            this.marketType,
            response.status
          )
        }

        this.rateLimiter?.recordSuccess()
        this.rateLimiter?.release()

        const data = (await response.json()) as T
        return data
      } catch (error) {
        this.rateLimiter?.release()

        if (
          error instanceof ConnectorError &&
          !error.isRateLimited &&
          (error.statusCode ?? 0) < 500
        ) {
          throw error // Non-retryable errors
        }

        lastError = toError(error)

        // Exponential backoff
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryBaseDelay * Math.pow(2, attempt)
          const jitter = Math.random() * 1000
          await this.sleep(delay + jitter)
        }
      }
    }

    throw lastError || new ConnectorError('Max retries exceeded', this.platform, this.marketType)
  }

  /**
   * Fetch via VPS Scraper
   * 
   * @param endpoint - VPS endpoint path (e.g., '/bingx/leaderboard')
   * @param params - Query parameters
   * @param timeoutMs - Request timeout (default: 120000ms = 2min)
   * @returns Response data or null if failed
   */
  protected async fetchViaVPS<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
    timeoutMs = 120000
  ): Promise<T | null> {
    const vpsHost = process.env.VPS_PROXY_URL || process.env.VPS_SCRAPER_HOST;
    const vpsKey = process.env.VPS_PROXY_KEY;

    if (!vpsHost || !vpsKey) {
      return null; // VPS not configured, return null to allow fallback
    }

    try {
      const queryString = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ).toString();
      const url = `${vpsHost}${endpoint}${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Proxy-Key': vpsKey,
          'User-Agent': this.config.userAgent,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        console.warn(`[VPS] ${this.platform} returned ${response.status}`);
        return null;
      }

      const data = await response.json() as T;
      return data;
    } catch (error) {
      console.warn(`[VPS] ${this.platform} failed:`, toError(error).message);
      return null;
    }
  }

  // ============================================
  // Quality Flag Helpers
  // ============================================

  /**
   * Build quality flags based on available metrics.
   */
  protected buildQualityFlags(
    metrics: Partial<SnapshotMetrics>,
    window: Window,
    isNativeWindow: boolean
  ): QualityFlags {
    const missingFields: string[] = []
    const nonStandardFields: Record<string, string> = {}

    if (metrics.roi === null || metrics.roi === undefined) missingFields.push('roi')
    if (metrics.pnl === null || metrics.pnl === undefined) missingFields.push('pnl')
    if (metrics.win_rate === null || metrics.win_rate === undefined) missingFields.push('win_rate')
    if (metrics.max_drawdown === null || metrics.max_drawdown === undefined)
      missingFields.push('max_drawdown')
    if (metrics.trades_count === null || metrics.trades_count === undefined)
      missingFields.push('trades_count')
    if (metrics.followers === null || metrics.followers === undefined)
      missingFields.push('followers')
    if (metrics.copiers === null || metrics.copiers === undefined) missingFields.push('copiers')

    const notes: string[] = []
    if (!isNativeWindow) {
      notes.push(`Window ${window} is not natively provided by ${this.platform}`)
    }

    return {
      missing_fields: missingFields,
      non_standard_fields: nonStandardFields,
      window_native: isNativeWindow,
      notes,
    }
  }

  /**
   * Build provenance information.
   */
  protected buildProvenance(
    sourceUrl: string | null,
    method: 'api' | 'scrape' | 'derived' | 'enrichment' = 'api'
  ): DataProvenance {
    return {
      source_platform: this.platform,
      acquisition_method: method,
      fetched_at: new Date().toISOString(),
      source_url: sourceUrl,
      scraper_version: '2.0.0',
    }
  }

  /**
   * Check if a window is natively supported by this platform.
   */
  protected isNativeWindow(window: Window): boolean {
    return this.capabilities.native_windows.includes(window)
  }

  /**
   * Map a window to the platform's equivalent.
   * Returns null if no mapping exists.
   */
  protected mapWindowToPlatform(window: Window): string | null {
    const mappings: Record<Window, string> = {
      '7d': 'WEEKLY',
      '30d': 'MONTHLY',
      '90d': 'QUARTERLY',
    }
    return mappings[window] || null
  }

  // ============================================
  // Utility Methods
  // ============================================

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Create an empty SnapshotMetrics with all null values.
   */
  protected emptyMetrics(): SnapshotMetrics {
    return {
      roi: null,
      pnl: null,
      win_rate: null,
      max_drawdown: null,
      sharpe_ratio: null,
      sortino_ratio: null,
      trades_count: null,
      followers: null,
      copiers: null,
      aum: null,
      platform_rank: null,
      arena_score: null,
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    }
  }

  /**
   * Generate the date bucket for idempotent writes.
   * Truncates to the current hour.
   */
  protected getDateBucket(): string {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return now.toISOString()
  }
}

// ============================================
// Legacy Base Connector (with inline rate limiter)
// ============================================

/**
 * Legacy BaseConnector that uses inline rate limiter and circuit breaker.
 * Kept for backward compatibility with existing connectors.
 */
export abstract class BaseConnectorLegacy {
  abstract readonly platform: GranularPlatform

  protected inlineRateLimiter: InlineRateLimiter
  protected circuitBreaker: CircuitBreaker

  constructor(rateLimitOverride?: Partial<RateLimiterConfig>) {
    this.inlineRateLimiter = null as unknown as InlineRateLimiter
    this.circuitBreaker = new CircuitBreaker()

    if (rateLimitOverride) {
      this._rateLimitOverride = rateLimitOverride
    }
  }

  private _rateLimitOverride?: Partial<RateLimiterConfig>

  /** Must be called after construction to initialize rate limiter */
  protected init(): void {
    const config = {
      ...PLATFORM_RATE_LIMITS[this.platform],
      ...this._rateLimitOverride,
    }
    this.inlineRateLimiter = new InlineRateLimiter(config)
  }

  /**
   * Execute a request with rate limiting, circuit breaker, and retry.
   */
  protected async requestWithCircuitBreaker<T>(
    fn: () => Promise<T>,
    options: { retries?: number; label?: string } = {}
  ): Promise<T> {
    const { retries = 3, label = 'request' } = options

    return this.circuitBreaker.execute(async () => {
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          await this.inlineRateLimiter.acquire()
          try {
            return await fn()
          } finally {
            this.inlineRateLimiter.release()
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          if (attempt < retries) {
            const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 1000
            exchangeLogger.warn(
              `[${this.platform}] ${label} attempt ${attempt + 1} failed, retrying in ${Math.round(backoff)}ms: ${lastError.message}`
            )
            await sleep(backoff)
          }
        }
      }

      throw new Error(
        `[${this.platform}] ${label} failed after ${retries + 1} attempts: ${lastError?.message}`
      )
    })
  }

  /**
   * Build a SnapshotQuality object from available metrics.
   */
  protected buildQuality<T extends object>(metrics: T): {
    is_complete: boolean
    missing_fields: string[]
    confidence: number
    is_interpolated: boolean
  } {
    const metricsRecord = metrics as unknown as Record<string, unknown>
    const allFields = Object.keys(metricsRecord)
    const missingFields = allFields.filter((f) => metricsRecord[f] === null || metricsRecord[f] === undefined)
    const totalFields = allFields.length
    const presentFields = totalFields - missingFields.length

    return {
      is_complete: missingFields.length === 0,
      missing_fields: missingFields,
      confidence: totalFields > 0 ? presentFields / totalFields : 0,
      is_interpolated: false,
    }
  }

  /**
   * Generate the date bucket for idempotent writes.
   */
  protected getDateBucket(): string {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return now.toISOString()
  }
}

// ============================================
// Utility
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
