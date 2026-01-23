/**
 * Connector Framework Types
 *
 * Defines the interface all platform connectors must implement.
 */

import type {
  LeaderboardPlatform,
  MarketType,
  Window,
  DiscoverResult,
  ProfileResult,
  SnapshotResult,
  TimeseriesResult,
  PlatformCapabilities,
} from '../types/leaderboard'

/**
 * Base interface for all platform connectors.
 * Each platform must implement this interface.
 */
export interface PlatformConnector {
  /** Platform identifier */
  readonly platform: LeaderboardPlatform
  /** Market type this connector handles */
  readonly marketType: MarketType
  /** Platform capabilities and limitations */
  readonly capabilities: PlatformCapabilities

  /** Set rate limiter for this connector */
  setRateLimiter(limiter: RateLimiter): void

  /**
   * Discover traders from the platform's leaderboard.
   * Returns a list of trader sources (keys + basic info).
   *
   * @param window - Time window to query
   * @param limit - Max number of traders to discover
   * @param offset - Pagination offset
   */
  discoverLeaderboard(
    window: Window,
    limit?: number,
    offset?: number
  ): Promise<DiscoverResult>

  /**
   * Fetch enriched profile data for a specific trader.
   * Returns null if profile data is not available.
   *
   * @param traderKey - Platform-specific trader ID
   */
  fetchTraderProfile(traderKey: string): Promise<ProfileResult | null>

  /**
   * Fetch snapshot metrics for a specific trader and window.
   * Returns null if the window is not supported.
   *
   * @param traderKey - Platform-specific trader ID
   * @param window - Time window
   */
  fetchTraderSnapshot(
    traderKey: string,
    window: Window
  ): Promise<SnapshotResult | null>

  /**
   * Fetch timeseries data for a specific trader.
   * Returns empty array if timeseries is not available.
   *
   * @param traderKey - Platform-specific trader ID
   */
  fetchTimeseries(traderKey: string): Promise<TimeseriesResult>

  /**
   * Normalize raw platform data to canonical format.
   * Called internally by other methods.
   *
   * @param raw - Raw platform response
   */
  normalize(raw: unknown): Record<string, unknown>
}

/**
 * Configuration for a connector instance.
 */
export interface ConnectorConfig {
  /** Request timeout in milliseconds */
  timeout: number
  /** Max retries per request */
  maxRetries: number
  /** Base delay between retries (exponential backoff) */
  retryBaseDelay: number
  /** User-Agent string to use */
  userAgent: string
  /** Proxy URL (optional) */
  proxyUrl?: string
  /** Additional headers */
  headers?: Record<string, string>
}

/**
 * Default connector configuration.
 */
export const DEFAULT_CONNECTOR_CONFIG: ConnectorConfig = {
  timeout: 30000,
  maxRetries: 3,
  retryBaseDelay: 2000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/**
 * Error thrown by connectors when a platform-specific issue occurs.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly platform: LeaderboardPlatform,
    public readonly marketType: MarketType,
    public readonly statusCode?: number,
    public readonly isRateLimited?: boolean,
    public readonly retryAfter?: number
  ) {
    super(`[${platform}/${marketType}] ${message}`)
    this.name = 'ConnectorError'
  }
}

/**
 * Rate limiter interface for connectors.
 */
export interface RateLimiter {
  /** Acquire a permit (blocks until available) */
  acquire(): Promise<void>
  /** Release a permit */
  release(): void
  /** Check if circuit breaker is open */
  isCircuitOpen(): boolean
  /** Record a success */
  recordSuccess(): void
  /** Record a failure */
  recordFailure(): void
  /** Get current state */
  getState(): {
    availablePermits: number
    circuitOpen: boolean
    consecutiveFailures: number
  }
}
