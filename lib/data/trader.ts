/**
 * Trader Data — public API for trader detail pages.
 * Re-exports from focused modules:
 * - trader-types.ts: Type definitions
 * - trader-utils.ts: Source lookup utilities (findTraderAcrossSources)
 * - trader-queries.ts: Query functions (getTraderByHandle, getTraderPerformance, etc.)
 */

// Re-export all types
export type {
  TraderSource,
  TraderSourceWithWeb3,
  TraderSourceRecord,
  TraderProfile,
  TraderPerformance,
  TraderStats,
  PortfolioItem,
  PositionHistoryItem,
  TraderFeedItem,
} from './trader-types'

// Re-export DataResult type for consumers
export type { DataResult } from '@/lib/types/result'

export { TRADER_SOURCES, TRADER_SOURCES_WITH_WEB3 } from './trader-types'

// Re-export utility functions
export {
  findTraderAcrossSources,
  findTradersAcrossSources,
  getTraderArenaFollowersCountBatch,
  clearSourceCache,
} from './trader-utils'

// Re-export query functions
export {
  getTraderByHandle,
  getTraderPerformance,
  getTraderStats,
  getTraderFrequentlyTraded,
  getTraderPortfolio,
  getTraderPositionHistory,
  getTraderFeed,
  getSimilarTraders,
} from './trader-queries'
