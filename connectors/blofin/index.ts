/**
 * BloFin Copy Trading Connector
 *
 * Source: https://blofin.com/en/copy-trade
 * API: https://openapi.blofin.com/api/v1/copytrading/public/*
 * Windows: 7D, 30D, 90D
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://openapi.blofin.com';

export class BlofinConnector extends BaseConnector {
  platform: Platform = 'blofin';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 30, concurrent: 3, delay_ms: 2000 };

  async discoverLeaderboard(window: Window, limit = 50): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7', '30d': '30', '90d': '90' };
      const period = periodMap[window] || '30';

      const url = `${API_BASE}/api/v1/copytrading/public/leaderboard?period=${period}&limit=${Math.min(limit, 100)}`;
      const response = await this.fetchJSON<{ data: { list: Record<string, unknown>[] } }>(url, {
        headers: {
          'Origin': 'https://blofin.com',
          'Referer': 'https://blofin.com/en/copy-trade',
        },
      });

      if (!response?.data?.list) {
        return this.success([], {
          source_url: url,
          platform_sorting: 'default',
          reason: 'BloFin leaderboard may require auth or endpoint changed',
        });
      }

      const entries: LeaderboardEntry[] = response.data.list.map((item, idx) => ({
        trader_key: String(item.traderId || item.uniqueCode || ''),
        display_name: (item.nickName as string) || (item.nickname as string) || null,
        avatar_url: (item.avatar as string) || null,
        profile_url: `https://blofin.com/en/copy-trade/details/${item.traderId || item.uniqueCode}`,
        rank: idx + 1,
        metrics: this.normalize(item),
        raw: item,
      }));

      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`BloFin leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/api/v1/copytrading/public-lead-traders/detail?uniqueCode=${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: {
          'Origin': 'https://blofin.com',
          'Referer': 'https://blofin.com/en/copy-trade',
        },
      });

      if (!response?.data) {
        return this.failure('BloFin trader profile not found');
      }

      const d = response.data;
      return this.success({
        platform: 'blofin',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatar as string) || null,
        bio: null,
        tags: ['copy-trading'],
        profile_url: `https://blofin.com/en/copy-trade/details/${trader_key}`,
        followers: this.parseNumber(d.followers) as number | null,
        copiers: this.parseNumber(d.copiers) as number | null,
        aum: this.parseNumber(d.aum) as number | null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`BloFin profile failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(_trader_key: string, _window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    return this.failure('BloFin snapshots require further endpoint discovery');
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([]);
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi ?? raw.roiRate ?? raw.profitRate),
      pnl_usd: this.parseNumber(raw.pnl ?? raw.profit ?? raw.totalProfit),
      win_rate: this.parseNumber(raw.winRate ?? raw.win_rate),
      max_drawdown: this.parseNumber(raw.maxDrawdown ?? raw.max_drawdown),
      trades_count: this.parseNumber(raw.tradeCount ?? raw.totalTrades) as number | null,
      followers: this.parseNumber(raw.followers ?? raw.followerCount) as number | null,
      copiers: this.parseNumber(raw.copiers) as number | null,
      sharpe_ratio: this.parseNumber(raw.sharpeRatio ?? raw.sharpe_ratio) as number | null,
      aum: this.parseNumber(raw.aum ?? raw.totalAssets) as number | null,
    };
  }
}
