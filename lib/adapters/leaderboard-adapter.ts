/**
 * Adapter: converts new leaderboard API responses to existing component formats.
 *
 * This bridge allows the existing RankingTable component to consume data from
 * the new /api/rankings endpoint without any UI changes.
 *
 * Maps: RankedTraderRow → Trader (RankingTable's interface)
 */

import type { RankedTraderRow, RankingWindow, TraderDetailResponse } from '@/lib/types/leaderboard';
import type { Trader } from '@/app/components/ranking/RankingTable';

/**
 * Convert a RankedTraderRow from the new API to the existing Trader format
 * used by the RankingTable component.
 */
export function adaptRankedTrader(row: RankedTraderRow): Trader {
  const metrics = row.metrics;

  // Map platform to the existing source format
  const sourceMap: Record<string, string> = {
    binance_futures: 'binance_futures',
    binance_spot: 'binance_spot',
    binance_web3: 'binance_web3',
    bybit: 'bybit',
    bitget_futures: 'bitget_futures',
    bitget_spot: 'bitget_spot',
    mexc: 'mexc',
    coinex: 'coinex',
    okx: 'okx',
    okx_wallet: 'okx_web3',
    kucoin: 'kucoin',
    gmx: 'gmx',
    dydx: 'dydx',
    hyperliquid: 'hyperliquid',
    bitmart: 'bitmart',
    phemex: 'phemex',
    htx: 'htx',
    weex: 'weex',
  };

  return {
    id: `${row.platform}:${row.trader_key}`,
    handle: row.display_name || row.trader_key.slice(0, 8),
    roi: metrics.roi_pct ?? 0,
    pnl: metrics.pnl_usd ?? null,
    win_rate: metrics.win_rate_pct ?? null,
    max_drawdown: metrics.max_drawdown_pct ?? null,
    trades_count: metrics.trades_count ?? null,
    followers: metrics.copier_count ?? 0,
    source: sourceMap[row.platform] || row.platform,
    avatar_url: row.avatar_url,
    arena_score: metrics.arena_score ?? undefined,
    return_score: metrics.return_score ?? undefined,
    drawdown_score: metrics.drawdown_score ?? undefined,
    stability_score: metrics.stability_score ?? undefined,
  };
}

/**
 * Convert a list of RankedTraderRow to Trader[].
 */
export function adaptRankings(rows: RankedTraderRow[]): Trader[] {
  return rows.map(adaptRankedTrader);
}

/**
 * Convert RankingWindow to the existing TimeRange format.
 */
export function windowToTimeRange(window: RankingWindow): '7D' | '30D' | '90D' {
  const map: Record<RankingWindow, '7D' | '30D' | '90D'> = {
    '7d': '7D',
    '30d': '30D',
    '90d': '90D',
  };
  return map[window];
}

/**
 * Convert existing TimeRange to RankingWindow.
 */
export function timeRangeToWindow(timeRange: '7D' | '30D' | '90D'): RankingWindow {
  const map: Record<string, RankingWindow> = {
    '7D': '7d',
    '30D': '30d',
    '90D': '90d',
  };
  return map[timeRange] || '90d';
}

/**
 * Relative time formatting for freshness display.
 */
export function formatRelativeTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return 'Never';

  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

/**
 * Determine freshness level for UI styling.
 */
export function getFreshnessLevel(isoTimestamp: string | null): 'fresh' | 'aging' | 'stale' | 'unknown' {
  if (!isoTimestamp) return 'unknown';

  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const hours = diff / 3_600_000;

  if (hours < 1) return 'fresh';
  if (hours < 4) return 'aging';
  return 'stale';
}
