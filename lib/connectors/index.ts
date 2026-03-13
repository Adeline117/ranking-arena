/**
 * Connector Framework - Public API
 *
 * Main exports for job processor and registry system
 */

// New multi-exchange registry (for job processor)
export { connectorRegistry, initializeConnectors, getConnector as getRegistryConnector, getAvailablePlatforms } from './registry'

// Base connector classes
export { BaseConnector, BaseConnectorLegacy, CircuitOpenError } from './base'

// Rate limiters
export { TokenBucketRateLimiter, DelayRateLimiter, createRateLimiter } from './rate-limiter'

// Types and errors
export type { PlatformConnector, ConnectorConfig, RateLimiter as RateLimiterType, CircuitState, CircuitBreaker } from './types'
export { ConnectorError, DEFAULT_CONNECTOR_CONFIG } from './types'

// Individual platform connectors — now in lib/connectors/platforms/ via registry
// Legacy re-exports removed (2026-03-13) — use connectorRegistry.get() instead
