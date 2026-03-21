/**
 * Connector Framework Types
 *
 * Defines the interface all platform connectors must implement.
 * Includes both the legacy simple interface and the new comprehensive one.
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
 * Base interface for all platform connectors (new format).
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
   */
  discoverLeaderboard(
    window: Window,
    limit?: number,
    offset?: number
  ): Promise<DiscoverResult>

  /**
   * Fetch enriched profile data for a specific trader.
   * Returns null if profile data is not available.
   */
  fetchTraderProfile(traderKey: string): Promise<ProfileResult | null>

  /**
   * Fetch snapshot metrics for a specific trader and window.
   * Returns null if the window is not supported.
   */
  fetchTraderSnapshot(
    traderKey: string,
    window: Window
  ): Promise<SnapshotResult | null>

  /**
   * Fetch timeseries data for a specific trader.
   * Returns empty array if timeseries is not available.
   */
  fetchTimeseries(traderKey: string): Promise<TimeseriesResult>

  /**
   * Normalize raw platform data to canonical format.
   * Called internally by other methods.
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
  /** Maximum concurrent requests (legacy) */
  maxConcurrent?: number
  /** Minimum delay between requests in ms (legacy) */
  minDelayMs?: number
  /** Circuit breaker failure threshold (legacy) */
  failureThreshold?: number
  /** Circuit breaker recovery time in ms (legacy) */
  recoveryTimeMs?: number
}

/**
 * Default connector configuration.
 */
export const DEFAULT_CONNECTOR_CONFIG: ConnectorConfig = {
  timeout: 30000,
  maxRetries: 3,
  retryBaseDelay: 2000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  maxConcurrent: 2,
  minDelayMs: 2000,
  failureThreshold: 5,
  recoveryTimeMs: 60000,
}

/**
 * Connector timeout tiers.
 * fast: direct API, no WAF (binance, okx, hyperliquid, drift, btcc, bitunix, etoro, web3_bot)
 * medium: VPS proxy or light WAF (bybit, bitget, mexc, gateio, coinex, htx, aevo, gains, jupiter, dydx)
 * slow: heavy WAF, Playwright scraper, geo-blocked (bingx, xt, blofin, toobit, weex, phemex, lbank, kwenta)
 */
export type ConnectorTier = 'fast' | 'medium' | 'slow'

export const CONNECTOR_TIER_CONFIG: Record<ConnectorTier, Partial<ConnectorConfig>> = {
  fast:   { timeout: 15000, maxRetries: 2, retryBaseDelay: 1000 },
  medium: { timeout: 30000, maxRetries: 3, retryBaseDelay: 2000 },
  slow:   { timeout: 120000, maxRetries: 2, retryBaseDelay: 5000 },
}

export const PLATFORM_TIER: Record<string, ConnectorTier> = {
  // Fast: direct API, no WAF
  binance_futures: 'fast', binance_spot: 'fast', binance_web3: 'fast',
  okx_futures: 'fast', okx_web3: 'fast',
  hyperliquid: 'fast', drift: 'fast', btcc: 'fast', bitunix: 'fast',
  etoro: 'fast', web3_bot: 'fast', bitfinex: 'fast',
  // Medium: VPS proxy or light WAF
  bybit: 'medium', bitget_futures: 'medium', mexc: 'medium',
  gateio: 'medium', coinex: 'medium', htx_futures: 'fast',
  aevo: 'medium', gains: 'medium', jupiter_perps: 'fast',
  dydx: 'medium', gmx: 'medium',
  // Slow: heavy WAF, scraper required
  bingx: 'slow', xt: 'slow', blofin: 'slow', toobit: 'slow',
  weex: 'slow', phemex: 'slow', lbank: 'slow', kwenta: 'slow',
  // New platforms (Wave 2)
  woox: 'fast', polymarket: 'fast', copin: 'fast',
}

/** Get ConnectorConfig for a platform based on its tier */
export function getConnectorConfigForPlatform(platform: string): ConnectorConfig {
  const tier = PLATFORM_TIER[platform] || 'medium'
  return { ...DEFAULT_CONNECTOR_CONFIG, ...CONNECTOR_TIER_CONFIG[tier] }
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

/**
 * Circuit breaker states
 */
export type CircuitState = 'closed' | 'open' | 'half-open'

/**
 * Circuit breaker interface for platform resilience.
 */
export interface CircuitBreaker {
  /** Current state of the circuit */
  readonly state: CircuitState
  /** Execute a function with circuit breaker protection */
  execute<T>(fn: () => Promise<T>): Promise<T>
  /** Record a success */
  recordSuccess(): void
  /** Record a failure */
  recordFailure(): void
}
