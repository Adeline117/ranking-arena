/**
 * WEEX Copy Trading Connector
 *
 * Source: https://www.weex.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D supported; 90D may not be available
 * ROI Sort: Not confirmed (platform default + client-side sort)
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.weex.com';

export class WeexConnector extends BaseConnector {
  platform: Platform = 'weex';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 10, concurrent: 1, delay_ms: 5000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' };

      // Try VPS scraper first
      const vpsResponse = await this.fetchViaVPS<{ data: { list: Record<string, unknown>[] } }>('/weex/leaderboard', {
        page: 1,
        pageSize: Math.min(limit, 50),
        period: periodMap[window],
      });

      let list: Record<string, unknown>[] = [];
      let sourceUrl = `${API_BASE}/api/copy-trade/public/trader/ranking`;

      if (vpsResponse?.data?.list) {
        list = vpsResponse.data.list;
      } else {
        // Fallback to direct API
        const params = new URLSearchParams({
          page: '1',
          pageSize: String(Math.min(limit, 50)),
          sortBy: 'roi',
          period: periodMap[window],
        });

        const url = `${API_BASE}/api/copy-trade/public/trader/ranking?${params.toString()}`;
        sourceUrl = url;
        const response = await this.fetchJSON<{ data: { list: Record<string, unknown>[] } }>(url, {
          headers: { 'Origin': API_BASE, 'Referer': `${API_BASE}/copy-trading` },
        });

        if (response?.data?.list) {
          list = response.data.list;
        }
      }

      if (list.length === 0) {
        return this.success([], {
          source_url: sourceUrl,
          platform_sorting: 'default',
          reason: 'WEEX leaderboard endpoint not confirmed',
        }, { window_not_supported: window === '90d' });
      }

      const entries: LeaderboardEntry[] = list.map((item, idx) => ({
        trader_key: String(item.traderId || item.uid),
        display_name: (item.nickName as string) || null,
        avatar_url: (item.avatar as string) || null,
        profile_url: `${API_BASE}/copy-trading/trader/${item.traderId}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      // Client-side ROI sort
      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: sourceUrl,
        platform_sorting: 'default',
        reason: 'WEEX may not support server-side ROI sort',
      });
    } catch (error) {
      return this.failure(`WEEX leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(_trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.failure('WEEX profiles require further endpoint discovery');
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('WEEX snapshots require further endpoint discovery');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.roiRate ?? raw.yieldRate),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.profit),
      win_rate: this.parseNumber(raw.winRate ?? raw.win_rate),
      max_drawdown: this.parseNumber(raw.maxDrawdown ?? raw.max_drawdown),
      trades_count: this.parseNumber(raw.tradeCount) as number | null,
      followers: this.parseNumber(raw.followerCount) as number | null,
      copiers: null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}
