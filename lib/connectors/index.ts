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

/**
 * ============================================
 * P0 Enrichment Connectors (NEW)
 * ============================================
 * 
 * Simple API wrappers for enrichment scripts
 */

export { BaseExchangeConnector, type TraderData, type ListParams, type EnrichmentResult } from './base-connector-enrichment'
export { BitgetFuturesConnector as BitgetFuturesEnrichment } from './bitget-futures-enrichment'
export { HTXFuturesConnector as HTXFuturesEnrichment } from './htx-futures-enrichment'
export { BinanceWeb3Connector as BinanceWeb3Enrichment } from './binance-web3-enrichment'
export { BingXSpotConnector as BingXSpotEnrichment } from './bingx-spot-enrichment'

/**
 * Factory function for enrichment connectors
 * (For use in enrichment scripts - import directly in TS/Next.js code)
 */
export async function getEnrichmentConnector(source: string) {
  switch (source) {
    case 'bitget_futures': {
      const { BitgetFuturesConnector } = await import('./bitget-futures-enrichment')
      return new BitgetFuturesConnector()
    }
    case 'htx_futures': {
      const { HTXFuturesConnector } = await import('./htx-futures-enrichment')
      return new HTXFuturesConnector()
    }
    case 'binance_web3': {
      const { BinanceWeb3Connector } = await import('./binance-web3-enrichment')
      return new BinanceWeb3Connector()
    }
    case 'bingx_spot': {
      const { BingXSpotConnector } = await import('./bingx-spot-enrichment')
      return new BingXSpotConnector()
    }
    default:
      throw new Error(`Unknown enrichment source: ${source}`)
  }
}
