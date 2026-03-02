/**
 * Exchange Connectors
 * 
 * Unified API connectors for all supported exchanges
 */

export { BaseExchangeConnector, type TraderData, type ListParams, type EnrichmentResult, RateLimiter } from './base-connector'
export { BitgetFuturesConnector } from './bitget-futures'
export { HTXFuturesConnector } from './htx-futures'
export { BinanceWeb3Connector } from './binance-web3'
export { BingXSpotConnector } from './bingx-spot'

/**
 * Factory function to get connector by source
 */
export function getConnector(source: string) {
  switch (source) {
    case 'bitget_futures':
      return new BitgetFuturesConnector()
    case 'htx_futures':
      return new HTXFuturesConnector()
    case 'binance_web3':
      return new BinanceWeb3Connector()
    case 'bingx_spot':
      return new BingXSpotConnector()
    default:
      throw new Error(`Unknown source: ${source}`)
  }
}
