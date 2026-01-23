/**
 * Connector Framework - Public API
 *
 * Usage:
 *   import { connectorRegistry, initializeConnectors } from '@/lib/connectors'
 *
 *   await initializeConnectors()
 *   const connector = connectorRegistry.get('binance', 'futures')
 *   const result = await connector.discoverLeaderboard('30d', 100)
 *
 * Legacy usage:
 *   import { getConnector, getAvailablePlatforms } from '@/lib/connectors'
 *
 *   const connector = getConnector('binance_futures')
 */

// New multi-exchange registry
export { connectorRegistry, initializeConnectors, getConnector, getAvailablePlatforms } from './registry'

// Base connector classes
export { BaseConnector, BaseConnectorLegacy, CircuitOpenError } from './base'

// Rate limiters
export { TokenBucketRateLimiter, DelayRateLimiter, createRateLimiter } from './rate-limiter'

// Types and errors
export type { PlatformConnector, ConnectorConfig, RateLimiter, CircuitState, CircuitBreaker } from './types'
export { ConnectorError, DEFAULT_CONNECTOR_CONFIG } from './types'
