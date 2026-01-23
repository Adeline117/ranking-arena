/**
 * BitMart Copy Trading Connector
 *
 * Source: https://www.bitmart.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D supported; 90D may not be available
 * ROI Sort: Not directly confirmed (uses platform default + client-side ROI sort)
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.bitmart.com';

export class BitmartConnector extends BaseConnector {
  platform: Platform = 'bitmart';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 10, concurrent: 1, delay_ms: 5000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' };
      const params = new URLSearchParams({
        page: '1',
        size: String(Math.min(limit, 50)),
        period: periodMap[window],
        sort: 'roi',
        order: 'desc',
      });

      const url = `${API_BASE}/api/copy-trading/v1/public/trader/list?${params.toString()}`;
      const response = await this.fetchJSON<{ data: { list: Record<string, unknown>[] } }>(url, {
        headers: { 'Origin': API_BASE, 'Referer': `${API_BASE}/copy-trading` },
      });

      if (!response?.data?.list) {
        return this.success([], {
          source_url: url,
          platform_sorting: 'default',
          reason: 'BitMart leaderboard may not be publicly accessible or endpoint changed',
        });
      }

      const entries: LeaderboardEntry[] = response.data.list.map((item, idx) => ({
        trader_key: String(item.trader_id || item.uid),
        display_name: (item.nick_name as string) || null,
        avatar_url: (item.avatar as string) || null,
        profile_url: `${API_BASE}/copy-trading/trader/${item.trader_id}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      // Sort by ROI client-side if platform doesn't support it
      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`BitMart leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('BitMart individual profiles require further endpoint discovery');
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('BitMart snapshots require further endpoint discovery');
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.roi_rate ?? raw.pnl_ratio),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.profit),
      win_rate: this.parseNumber(raw.win_rate ?? raw.winRate),
      max_drawdown: this.parseNumber(raw.max_drawdown ?? raw.maxDrawdown),
      trades_count: this.parseNumber(raw.trade_count) as number | null,
      followers: this.parseNumber(raw.follower_count) as number | null,
      copiers: this.parseNumber(raw.copier_count) as number | null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}
