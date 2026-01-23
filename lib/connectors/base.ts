/**
 * Base Connector - Abstract base class for all platform connectors.
 *
 * Provides:
 * - HTTP request helpers with retry/backoff
 * - Rate limiting integration
 * - Quality flag generation
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
} from '../types/leaderboard'
import type { PlatformConnector, ConnectorConfig, RateLimiter } from './types'
import { ConnectorError, DEFAULT_CONNECTOR_CONFIG } from './types'

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

  abstract fetchTraderSnapshot(
    traderKey: string,
    window: Window
  ): Promise<SnapshotResult | null>

  abstract fetchTimeseries(traderKey: string): Promise<TimeseriesResult>

  abstract normalize(raw: unknown): Record<string, unknown>

  // ============================================
  // HTTP Request Helpers
  // ============================================

  /**
   * Make an HTTP request with retry, backoff, and rate limiting.
   */
  protected async request<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
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

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': this.config.userAgent,
            'Accept': 'application/json',
            ...this.config.headers,
            ...options?.headers,
          },
        })

        clearTimeout(timeout)

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

        const data = await response.json() as T
        return data
      } catch (error) {
        this.rateLimiter?.release()

        if (error instanceof ConnectorError && !error.isRateLimited && (error.statusCode ?? 0) < 500) {
          throw error  // Non-retryable errors
        }

        lastError = error as Error

        // Exponential backoff
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryBaseDelay * Math.pow(2, attempt)
          const jitter = Math.random() * 1000
          await this.sleep(delay + jitter)
        }
      }
    }

    throw lastError || new ConnectorError(
      'Max retries exceeded',
      this.platform,
      this.marketType
    )
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

    // Check for missing core fields
    if (metrics.roi === null || metrics.roi === undefined) missingFields.push('roi')
    if (metrics.pnl === null || metrics.pnl === undefined) missingFields.push('pnl')
    if (metrics.win_rate === null || metrics.win_rate === undefined) missingFields.push('win_rate')
    if (metrics.max_drawdown === null || metrics.max_drawdown === undefined) missingFields.push('max_drawdown')
    if (metrics.trades_count === null || metrics.trades_count === undefined) missingFields.push('trades_count')
    if (metrics.followers === null || metrics.followers === undefined) missingFields.push('followers')
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
    // Default mappings - subclasses can override
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
    return new Promise(resolve => setTimeout(resolve, ms))
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
}
