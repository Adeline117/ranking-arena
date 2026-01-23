/**
 * Connector Framework - Public API
 *
 * Usage:
 *   import { connectorRegistry, initializeConnectors } from '@/lib/connectors'
 *
 *   await initializeConnectors()
 *   const connector = connectorRegistry.get('binance', 'futures')
 *   const result = await connector.discoverLeaderboard('30d', 100)
 */

export { connectorRegistry, initializeConnectors } from './registry'
export { BaseConnector } from './base'
export { TokenBucketRateLimiter, createRateLimiter } from './rate-limiter'
export { PLATFORM_CAPABILITIES, getPlatformCapabilities, isWindowSupported } from './capabilities'
export type { PlatformConnector, ConnectorConfig, RateLimiter, ConnectorError } from './types'
