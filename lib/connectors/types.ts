/**
 * Connector Framework - Interface Definitions
 * Each platform connector must implement this interface.
 */

import type {
  Platform,
  SnapshotWindow,
  ConnectorTraderProfile,
  ConnectorSnapshot,
  ConnectorTimeseries,
  LeaderboardEntry,
} from '@/lib/types/trading-platform'

/**
 * Base connector interface that all platform connectors must implement.
 * Each method is independent and may throw on failure.
 */
export interface PlatformConnector {
  /** Platform identifier */
  readonly platform: Platform

  /**
   * Discover traders from the platform's leaderboard.
   * Returns a list of trader entries with basic metrics.
   * @param window - Time window to query (7D, 30D, 90D)
   * @param limit - Maximum number of traders to return
   */
  discoverLeaderboard(window: SnapshotWindow, limit?: number): Promise<LeaderboardEntry[]>

  /**
   * Fetch enriched profile data for a specific trader.
   * @param traderKey - Platform-specific trader identifier
   */
  fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile>

  /**
   * Fetch performance snapshot for a specific trader and window.
   * @param traderKey - Platform-specific trader identifier
   * @param window - Time window (7D, 30D, 90D)
   */
  fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot>

  /**
   * Fetch time-series data for a specific trader.
   * Returns equity curve, daily PnL, and/or asset breakdown.
   * @param traderKey - Platform-specific trader identifier
   */
  fetchTimeseries(traderKey: string): Promise<ConnectorTimeseries[]>
}

/**
 * Rate limiter interface for controlling request frequency per platform.
 */
export interface RateLimiter {
  /** Wait until a request slot is available */
  acquire(): Promise<void>
  /** Release a request slot (for cleanup) */
  release(): void
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

/**
 * Connector configuration
 */
export interface ConnectorConfig {
  /** Maximum concurrent requests */
  maxConcurrent: number
  /** Minimum delay between requests in ms */
  minDelayMs: number
  /** Maximum retries per request */
  maxRetries: number
  /** Base timeout in ms */
  timeoutMs: number
  /** Circuit breaker failure threshold */
  failureThreshold: number
  /** Circuit breaker recovery time in ms */
  recoveryTimeMs: number
}

/** Default connector configuration */
export const DEFAULT_CONNECTOR_CONFIG: ConnectorConfig = {
  maxConcurrent: 2,
  minDelayMs: 2000,
  maxRetries: 3,
  timeoutMs: 30000,
  failureThreshold: 5,
  recoveryTimeMs: 60000,
}
