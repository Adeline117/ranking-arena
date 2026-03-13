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
export { BinanceFuturesConnector } from './_deprecated/binance-futures'
export { BinanceSpotConnector } from './_deprecated/binance-spot'
export { BybitConnector } from './_deprecated/bybit'
export { BitgetFuturesConnector } from './_deprecated/bitget-futures'
export { OKXConnector } from './_deprecated/okx'
export { MEXCConnector } from './_deprecated/mexc'
export { KuCoinConnector } from './_deprecated/kucoin'
export { HyperliquidConnector } from './_deprecated/hyperliquid'
export { CoinExConnector } from './_deprecated/coinex'
export { BitgetSpotConnector } from './_deprecated/bitget-spot'
