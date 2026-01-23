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

import type { PlatformConnector } from './types'
import type { Platform } from '@/lib/types/trading-platform'
import { BybitFuturesConnector } from './bybit-futures'

// Base connector classes
export { BaseConnector, BaseConnectorLegacy, CircuitOpenError } from './base'

// Rate limiters
export { TokenBucketRateLimiter, DelayRateLimiter, createRateLimiter } from './rate-limiter'

// Types and errors
export type { PlatformConnector, ConnectorConfig, RateLimiter, CircuitState, CircuitBreaker } from './types'
export { ConnectorError, DEFAULT_CONNECTOR_CONFIG } from './types'

// Legacy createConnector function (simplified)
export function createConnector(platform: Platform): PlatformConnector | null {
  switch (platform) {
    case 'bybit':
      return new BybitFuturesConnector()
    default:
      return null
  }
}

export { type PlatformConnector } from './types'

// Individual platform connectors (direct imports)
export { BinanceFuturesConnector } from './binance-futures'
export { BinanceSpotConnector } from './binance-spot'
export { BybitConnector } from './bybit'
export { BitgetFuturesConnector } from './bitget-futures'
export { OKXConnector } from './okx'
export { MEXCConnector } from './mexc'
export { KuCoinConnector } from './kucoin'
export { HyperliquidConnector } from './hyperliquid'
export { CoinExConnector } from './coinex'
export { BitgetSpotConnector } from './bitget-spot'
