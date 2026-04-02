/**
 * Phemex Copy Trading Connector
 *
 * Source: https://phemex.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via sort=roi
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://phemex.com';

export class PhemexConnector extends BaseConnector {
  platform: Platform = 'phemex';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 10, concurrent: 1, delay_ms: 5000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7D', '30d': '30D', '90d': '90D' };

      // Try VPS scraper first
      const vpsResponse = await this.fetchViaVPS<{ data: { list: Record<string, unknown>[] } }>('/phemex/leaderboard', {
        page: 1,
        pageSize: Math.min(limit, 50),
        period: periodMap[window],
      });

      let list: Record<string, unknown>[] = [];
      let sourceUrl = `${API_BASE}/api/copy-trading/public/leader/ranking`;

      if (vpsResponse?.data?.list) {
        list = vpsResponse.data.list;
      } else {
        // Fallback to direct API
        const params = new URLSearchParams({
          page: '1',
          pageSize: String(Math.min(limit, 50)),
          period: periodMap[window],
          sort: 'roi',
          order: 'desc',
        });

        const url = `${API_BASE}/api/copy-trading/public/leader/ranking?${params.toString()}`;
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
          platform_sorting: 'roi_desc',
          reason: 'Phemex leaderboard endpoint may have changed',
        });
      }

      const entries: LeaderboardEntry[] = list.map((item, idx) => ({
        trader_key: String(item.leaderId || item.uid),
        display_name: (item.nickName as string) || null,
        avatar_url: (item.avatar as string) || null,
        profile_url: `${API_BASE}/copy-trading/leader/${item.leaderId}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      return this.success(entries.slice(0, limit), {
        source_url: sourceUrl,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Phemex leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/api/copy-trading/public/leader/detail?leaderId=${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'phemex',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatar as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/leader/${trader_key}`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('Phemex snapshot requires further endpoint discovery');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.roiRate ?? raw.pnlRatio),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.profit),
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: this.parseNumber(raw.maxDrawdown ?? raw.mdd),
      trades_count: this.parseNumber(raw.tradeCount) as number | null,
      followers: this.parseNumber(raw.followerCount) as number | null,
      copiers: this.parseNumber(raw.copierCount) as number | null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}
