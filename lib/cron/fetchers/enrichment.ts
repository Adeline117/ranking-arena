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

// Gate.io
export {
  fetchGateioEquityCurve,
  fetchGateioStatsDetail,
  fetchGateioCurrentPositions,
} from './enrichment-gateio'

// MEXC
export {
  fetchMexcEquityCurve,
  fetchMexcStatsDetail,
} from './enrichment-mexc'

// Drift
export {
  fetchDriftPositionHistory,
  fetchDriftPositionHistoryFromS3,
  fetchDriftEquityCurve,
  fetchDriftStatsDetail,
} from './enrichment-drift'

// dYdX
export {
  fetchDydxEquityCurve,
  fetchDydxStatsDetail,
  fetchDydxV4PositionHistory,
} from './enrichment-dydx'

// DEX (Hyperliquid + GMX)
export {
  fetchHyperliquidPositionHistory,
  fetchHyperliquidPortfolio,
  fetchHyperliquidEquityCurve,
  fetchHyperliquidStatsDetail,
  fetchGmxPositionHistory,
  fetchGmxPortfolio,
  fetchGmxEquityCurve,
  fetchGmxStatsDetail,
  computeStatsFromPositions,
  buildEquityCurveFromPositions,
} from './enrichment-dex'

// Copin-powered DEX (Aevo, Gains, Kwenta)
export {
  fetchAevoEquityCurve,
  fetchAevoStatsDetail,
  fetchAevoPositionHistory,
  fetchGainsEquityCurve,
  fetchGainsStatsDetail,
  fetchGainsPositionHistory,
  fetchKwentaEquityCurve,
  fetchKwentaStatsDetail,
  fetchKwentaPositionHistory,
} from './enrichment-copin'

// Jupiter Perps
export {
  fetchJupiterPositionHistory,
  fetchJupiterEquityCurve,
  fetchJupiterStatsDetail,
} from './enrichment-jupiter'

// On-chain (Etherscan V2 + Blockscout)
export {
  fetchGainsOnchainPositionHistory,
  fetchGainsOnchainEquityCurve,
  fetchGainsOnchainStatsDetail,
  fetchKwentaOnchainPositionHistory,
  fetchKwentaOnchainEquityCurve,
  fetchKwentaOnchainStatsDetail,
} from './enrichment-onchain'

// Database operations
export {
  upsertEquityCurve,
  upsertPositionHistory,
  upsertStatsDetail,
  upsertAssetBreakdown,
  upsertPortfolio,
} from './enrichment-db'
export type { V2EnrichUpdate } from './enrichment-db'

// On-chain wallet data (AUM, portfolio)
export {
  fetchWalletAUM,
  fetchWalletPortfolio,
  isDexPlatform,
} from './enrichment-wallet'

// BTCC
export {
  fetchBtccEquityCurve,
  fetchBtccStatsDetail,
} from './enrichment-btcc'

// eToro
export {
  fetchEtoroEquityCurve,
  fetchEtoroStatsDetail,
  fetchEtoroPortfolio,
} from './enrichment-etoro'

// CoinEx
export {
  fetchCoinexEquityCurve,
  fetchCoinexStatsDetail,
} from './enrichment-coinex'

// Bitunix — uses leaderboard list API with batch cache (individual endpoints 404)
export {
  fetchBitunixEquityCurve,
  fetchBitunixStatsDetail,
} from './enrichment-bitunix'

// XT.com — uses internal copy-trading list API with batch cache
export {
  fetchXtEquityCurve,
  fetchXtStatsDetail,
} from './enrichment-xt'

// Bitfinex
export {
  fetchBitfinexEquityCurve,
  fetchBitfinexStatsDetail,
  fetchBitfinexRoi,
} from './enrichment-bitfinex'

// BloFin
export {
  fetchBlofinEquityCurve,
  fetchBlofinStatsDetail,
} from './enrichment-blofin'

// Phemex
export {
  fetchPhemexEquityCurve,
  fetchPhemexStatsDetail,
} from './enrichment-phemex'

// BingX
export {
  fetchBingxEquityCurve,
  fetchBingxStatsDetail,
  fetchBingxCurrentPositions,
} from './enrichment-bingx'

// Toobit
export {
  fetchToobitEquityCurve,
  fetchToobitStatsDetail,
} from './enrichment-toobit'

// Binance Spot
export {
  fetchBinanceSpotEquityCurve,
  fetchBinanceSpotStatsDetail,
} from './enrichment-binance-spot'

// Derived metrics
export {
  calculateVolatility,
  calculateCurrentDrawdown,
  calculateMaxDrawdown,
  calculateSharpeRatio,
  enhanceStatsWithDerivedMetrics,
  calculateAssetBreakdown,
  classifyTradingStyle,
  calculateAvgHoldingHours,
  calculateAvgProfitLoss,
} from './enrichment-metrics'
