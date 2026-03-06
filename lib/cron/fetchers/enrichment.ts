/**
 * Trader Data Enrichment Module - Barrel Re-export
 *
 * Split into focused modules:
 * - enrichment-types.ts: Shared types + proxy utility
 * - enrichment-binance.ts: Binance fetchers + batch
 * - enrichment-bybit.ts: Bybit fetchers + batch
 * - enrichment-okx.ts: OKX fetchers
 * - enrichment-bitget.ts: Bitget fetchers
 * - enrichment-dex.ts: Hyperliquid + GMX fetchers
 * - enrichment-db.ts: Database upsert functions
 * - enrichment-metrics.ts: Derived metrics calculations
 */

// Types
export type {
  EquityCurvePoint,
  PositionHistoryItem,
  EnrichmentResult,
  StatsDetail,
  AssetBreakdown,
  PortfolioPosition,
} from './enrichment-types'

// Proxy utility
export { fetchWithProxyFallback } from './enrichment-types'

// Binance
export {
  fetchBinanceEquityCurve,
  fetchBinancePositionHistory,
  fetchBinanceStatsDetail,
  enrichBinanceTraders,
} from './enrichment-binance'

// Bybit
export {
  fetchBybitEquityCurve,
  fetchBybitPositionHistory,
  fetchBybitStatsDetail,
  enrichBybitTraders,
} from './enrichment-bybit'

// OKX
export {
  fetchOkxCurrentPositions,
  fetchOkxEquityCurve,
  fetchOkxPositionHistory,
  fetchOkxStatsDetail,
  convertOkxPnlRatiosToEquityCurve,
} from './enrichment-okx'

// Bitget
export {
  fetchBitgetEquityCurve,
  fetchBitgetPositionHistory,
  fetchBitgetStatsDetail,
} from './enrichment-bitget'

// HTX
export {
  fetchHtxEquityCurve,
  fetchHtxStatsDetail,
} from './enrichment-htx'

// DEX (Hyperliquid + GMX)
export {
  fetchHyperliquidPositionHistory,
  fetchGmxPositionHistory,
} from './enrichment-dex'

// Database operations
export {
  upsertEquityCurve,
  upsertPositionHistory,
  upsertStatsDetail,
  upsertAssetBreakdown,
  upsertPortfolio,
} from './enrichment-db'

// Derived metrics
export {
  calculateVolatility,
  calculateCurrentDrawdown,
  calculateMaxDrawdown,
  calculateSharpeRatio,
  enhanceStatsWithDerivedMetrics,
  calculateAssetBreakdown,
} from './enrichment-metrics'
