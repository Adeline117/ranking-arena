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

// Individual platform connectors (legacy)
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
