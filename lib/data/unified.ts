/**
 * lib/data/unified.ts — backward compatibility re-export.
 *
 * The actual implementation has been split into focused modules under lib/data/trader/.
 * All existing imports of `from '@/lib/data/unified'` continue to work.
 */
export { getLeaderboard, getTraderDetail, searchTraders, resolveTrader } from './trader/queries'
export { toTraderPageData } from './trader/bridge'
export type { UnifiedTrader, TraderDetail, TradingPeriod, EquityPoint, AssetWeight, TraderPosition } from './trader/types'
