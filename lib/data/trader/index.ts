/**
 * lib/data/trader — focused modules for the unified data access layer.
 * Re-exports everything for a clean public API.
 */

// Types
export type {
  UnifiedTrader,
  TraderDetail,
  TradingPeriod,
  EquityPoint,
  AssetWeight,
  TraderPosition,
} from './types'

// Mappers
export {
  mapLeaderboardRow,
  mapV1Snapshot,
  mapV2Snapshot,
  normalizeWinRate,
  normalizePeriod,
  SOURCE_ALIASES,
  getSourceAliases,
} from './mappers'

// Queries (public API)
export {
  getLeaderboard,
  getTraderDetail,
  searchTraders,
  resolveTrader,
  safeQuery,
  withTimeout,
} from './queries'

// Bridge
export { toTraderPageData } from './bridge'

// Similar traders
export { fetchSimilarTraders } from './similar'

// Schema mapping constants (re-export for convenience)
export { LR, V2, ENRICH } from '@/lib/types/schema-mapping'
export type { Period, Platform } from '@/lib/types/schema-mapping'
