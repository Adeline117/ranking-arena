/**
 * HTX (Huobi) Copy Trading Connector
 *
 * Source: https://www.htx.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via sortField=yield_rate
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.htx.com';

export class HtxConnector extends BaseConnector {
  platform: Platform = 'htx';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 10, concurrent: 1, delay_ms: 5000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' };
      const params = new URLSearchParams({
        page: '1',
        pageSize: String(Math.min(limit, 50)),
        sortField: 'yield_rate',
        sortOrder: 'desc',
        periodDays: periodMap[window],
      });

      const url = `${API_BASE}/v1/copy-trading/public/trader/list?${params.toString()}`;
      const response = await this.fetchJSON<{ data: { list: Record<string, unknown>[] } }>(url, {
        headers: { 'Origin': API_BASE, 'Referer': `${API_BASE}/copy-trading` },
      });

      if (!response?.data?.list) {
        return this.success([], {
          source_url: url,
          platform_sorting: 'roi_desc',
          reason: 'HTX leaderboard endpoint may require different path',
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

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`HTX leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(_trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('HTX profiles require further endpoint discovery');
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('HTX snapshots require further endpoint discovery');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.yield_rate ?? raw.roi ?? raw.roiRate),
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
