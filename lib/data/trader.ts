/**
 * Trader Data Adapter
 * 数据适配层 - 从 Supabase 获取交易员数据
 *
 * This file re-exports from focused modules:
 * - trader-types.ts: Type definitions
 * - trader-utils.ts: Core utility functions (findTraderAcrossSources, etc.)
 * - trader-queries.ts: Specific query functions (getTraderByHandle, etc.)
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

export {
  TRADER_SOURCES,
  TRADER_SOURCES_WITH_WEB3,
} from './trader-types'

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
  getTraderMonthlyPerformance,
  getTraderYearlyPerformance,
  getTraderPortfolio,
  getTraderPositionHistory,
  getTraderFeed,
  getSimilarTraders,
} from './trader-queries'
