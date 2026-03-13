/**
 * Platform Capabilities Matrix
 *
 * Comprehensive reference for all supported platforms:
 * - Available windows
 * - Available fields
 * - Rate limits
 * - Anti-scraping difficulty
 * - Implementation notes
 */

import type { PlatformCapabilities } from '../../types/leaderboard'

/**
 * Complete platform capabilities reference.
 * Used for planning and validation.
 */
export const PLATFORM_CAPABILITIES: PlatformCapabilities[] = [
  // ============================================
  // CEX Platforms
  // ============================================
  {
    platform: 'binance',
    market_types: ['futures', 'spot', 'web3'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'Leaderboard entry: encryptedUid as trader_key',
      'Windows: WEEKLY/MONTHLY/QUARTERLY via periodType param',
      'CloudFlare protection, needs realistic headers',
      'Detail API: getOtherLeaderboardBaseInfo + getOtherPerformance',
      'Equity curve via separate endpoint',
      'Spot & Web3 have separate leaderboard pages',
    ],
  },
  {
    platform: 'bybit',
    market_types: ['futures', 'copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'Copy trading leaderboard at /copytrading/leader-board',
      'trader_key: leaderMark (uid string)',
      'Windows: 7D/30D/90D natively supported',
      'API endpoint: /v5/copy-trading/master/list',
      'Detail: /v5/copy-trading/master/performance',
      'Equity curve available via performance API',
    ],
  },
  {
    platform: 'bitget',
    market_types: ['futures', 'spot'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 20, concurrency: 2 },
    notes: [
      'Copy trading leaderboard with REST API',
      'trader_key: traderId',
      'Futures and Spot have separate leaderboards',
      'Windows via timeRange param: 7D/30D/90D',
      'Detail API provides comprehensive metrics',
      'Spot leaderboard has different endpoint',
    ],
  },
  {
    platform: 'mexc',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: uid',
      'Windows: 7D/30D/90D',
      'max_drawdown may not be available',
      'Limited timeseries data',
    ],
  },
  {
    platform: 'coinex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: trader_id',
      '90D NOT natively provided, mark as missing',
      'Limited metrics compared to larger exchanges',
    ],
  },
  {
    platform: 'okx',
    market_types: ['futures', 'copy'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'max_drawdown', 'followers', 'copiers', 'aum', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 15, concurrency: 2 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: uniqueName or leaderId',
      'All 3 windows supported',
      'API at /api/v5/copytrading/',
      'Comprehensive metrics available',
      'OKX Wallet is separate concept - mapped/degraded',
    ],
  },
  {
    platform: 'kucoin',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 15, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: uid',
      'Windows: 7D/30D/90D',
      'Limited detail data',
    ],
  },
  {
    platform: 'bitmart',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],
    available_fields: ['roi', 'pnl', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: trader_id',
      '90D NOT natively provided',
      'Limited metrics: no win_rate, no max_drawdown natively',
      'Higher scraping difficulty due to bot detection',
    ],
  },
  {
    platform: 'phemex',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: uid',
      'All windows supported',
      'max_drawdown may require separate call',
    ],
  },
  {
    platform: 'htx',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: [
      'Formerly Huobi, copy trading leaderboard',
      'trader_key: uid',
      'All windows supported',
      'Higher difficulty due to frequent page structure changes',
    ],
  },
  {
    platform: 'weex',
    market_types: ['futures'],
    native_windows: ['7d', '30d'],
    available_fields: ['roi', 'pnl', 'followers', 'copiers', 'platform_rank'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 3,
    rate_limit: { rpm: 10, concurrency: 1 },
    notes: [
      'Copy trading leaderboard',
      'trader_key: uid',
      '90D NOT natively provided',
      'Limited metrics',
      'Newer exchange, API may change frequently',
    ],
  },

  // ============================================
  // DEX / On-chain / Perp Platforms
  // ============================================
  {
    platform: 'gmx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'max_drawdown', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'On-chain perpetual DEX on Arbitrum/Avalanche',
      'trader_key: wallet address (0x...)',
      'No copy trading / no followers concept',
      'No win_rate (different trading model)',
      'Data from subgraph or stats API',
      'Fully transparent on-chain data',
    ],
  },
  {
    platform: 'dydx',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'max_drawdown', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'Decentralized perpetual exchange (dYdX v4 on Cosmos)',
      'trader_key: dydx address',
      'Leaderboard API: /v4/leaderboard',
      'No copy trading / no followers',
      'PnL leaderboard with comprehensive metrics',
      'Public API with good rate limits',
    ],
  },
  {
    platform: 'hyperliquid',
    market_types: ['perp'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'max_drawdown', 'trades_count', 'platform_rank'],
    has_timeseries: true,
    has_profiles: false,
    scraping_difficulty: 1,
    rate_limit: { rpm: 30, concurrency: 3 },
    notes: [
      'High-performance L1 perp DEX',
      'trader_key: wallet address (0x...)',
      'Public info API at info.hyperliquid.xyz',
      'No copy trading concept',
      'Comprehensive trade history available',
      'Very good API with clear documentation',
    ],
  },
]

/**
 * Get capabilities for a specific platform.
 */
export function getPlatformCapabilities(platform: string): PlatformCapabilities | null {
  return PLATFORM_CAPABILITIES.find(c => c.platform === platform) || null
}

/**
 * Check if a window is natively supported by a platform.
 */
export function isWindowSupported(platform: string, window: string): boolean {
  const caps = getPlatformCapabilities(platform)
  if (!caps) return false
  return (caps.native_windows as readonly string[]).includes(window)
}

/**
 * Get all platforms that support a given window.
 */
export function getPlatformsByWindow(window: string): string[] {
  return PLATFORM_CAPABILITIES
    .filter(c => (c.native_windows as readonly string[]).includes(window))
    .map(c => c.platform)
}
