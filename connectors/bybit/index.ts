/**
 * Bybit Copy Trading Connector
 *
 * Source: https://www.bybit.com/copyTrading/traderRanking
 * API: Public v5 copy trade endpoints
 * Windows: 7D, 30D, 90D via periodType
 * ROI Sort: Supported via sortField=ROI
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://api2.bybit.com';
const LIST_URL = `${API_BASE}/fapi/beehive/public/v1/common/dynamic-leader-list`;
const PROFILE_URL = `${API_BASE}/fapi/beehive/public/v1/common/leader-details`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'WEEKLY',
  '30d': 'MONTHLY',
  '90d': 'QUARTERLY',
};

export class BybitConnector extends BaseConnector {
  platform: Platform = 'bybit';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 20, concurrent: 2, delay_ms: 3000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first (bypasses WAF)
        const vpsResponse = await this.fetchViaVPS<BybitListResponse>('/bybit/leaderboard', {
          page,
          pageSize,
          timeRange: WINDOW_MAP[window],
        });

        let list: BybitLeaderItem[] = [];

        if (vpsResponse?.result?.list || vpsResponse?.result?.leaderList) {
          list = vpsResponse.result.list || vpsResponse.result.leaderList || [];
        } else if (vpsResponse?.data?.list) {
          list = vpsResponse.data.list;
        } else {
          // Fallback to direct API (likely to fail with 403)
          const body = {
            pageNo: page,
            pageSize: pageSize,
            timeRange: WINDOW_MAP[window],
            dataType: 'ROI',
            sortField: 'ROI',
            sortType: 'DESC',
          };

          const response = await this.postJSON<BybitListResponse>(
            LIST_URL,
            body,
            {
              'Referer': 'https://www.bybit.com/copyTrade/tradeCenter/leaderBoard',
              'Origin': 'https://www.bybit.com',
            }
          );

          list = response?.result?.list || response?.data?.list || [];
        }
        if (list.length === 0) break;

        for (const item of list) {
          entries.push({
            trader_key: item.leaderMark || item.leaderId,
            display_name: item.nickName || null,
            avatar_url: item.avatar || item.avatarUrl || null,
            profile_url: `https://www.bybit.com/copyTrade/tradeCenter/leaderBoard/detail?leaderMark=${item.leaderMark || item.leaderId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (list.length < pageSize) break;
        await this.sleep(this.getRandomDelay(2000, 4000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_URL,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Bybit leaderboard fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const params = new URLSearchParams({ leaderMark: trader_key });
      const response = await this.fetchJSON<{ result: Record<string, unknown>; data: Record<string, unknown> }>(
        `${PROFILE_URL}?${params.toString()}`,
        {
          headers: {
            'Referer': `https://www.bybit.com/copyTrade/tradeCenter/leaderBoard/detail?leaderMark=${trader_key}`,
            'Origin': 'https://www.bybit.com',
          },
        }
      );

      const d = response?.result || response?.data;
      if (!d) return this.failure('Profile not found');

      return this.success<CanonicalProfile>({
        platform: 'bybit',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatar as string) || (d.avatarUrl as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `https://www.bybit.com/copyTrade/tradeCenter/leaderBoard/detail?leaderMark=${trader_key}`,
        followers: this.parseNumber(d.followerCount || d.followerNum) as number | null,
        copiers: this.parseNumber(d.copierNum || d.currentFollowerCount) as number | null,
        aum: this.parseNumber(d.totalAssets || d.aum) as number | null,
        provenance: this.buildProvenance(PROFILE_URL),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/fapi/beehive/public/v1/common/leader-performance`;
      const body = {
        leaderId: trader_key,
        timeRange: WINDOW_MAP[window],
      };
      const response = await this.postJSON<{ result: Record<string, unknown>; data: Record<string, unknown> }>(
        url,
        body,
        {
          'Referer': `https://www.bybit.com/copyTrade/tradeCenter/leaderBoard/detail?leaderMark=${trader_key}`,
          'Origin': 'https://www.bybit.com',
        }
      );

      const data = response?.result || response?.data;
      if (!data) return this.failure('Snapshot not found');

      const metrics = this.normalize(data, FIELD_MAP);
      return this.success<CanonicalSnapshot>({
        platform: 'bybit',
        market_type: 'futures',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics: metrics as SnapshotMetrics,
        quality_flags: this.buildQualityFlags(metrics),
        provenance: this.buildProvenance(url, { platform_sorting: 'roi_desc', platform_window: window }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    try {
      const params = new URLSearchParams({ leaderMark: trader_key });
      const url = `${API_BASE}/fapi/beehive/public/v1/common/leader/equity-curve?${params.toString()}`;
      const response = await this.fetchJSON<{ result: { equityCurve: Array<{ time: string; equity: number }> } }>(url, {
        headers: { 'Origin': 'https://www.bybit.com' },
      });

      if (!response?.result?.equityCurve) return this.success([]);

      return this.success<CanonicalTimeseries[]>([{
        platform: 'bybit',
        market_type: 'futures',
        trader_key,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: response.result.equityCurve.map(p => ({
          ts: p.time,
          value: p.equity,
        })),
        provenance: this.buildProvenance(url),
      }]);
    } catch (error) {
      return this.success([], { reason: `Timeseries failed: ${(error as Error).message}` });
    }
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi']),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'totalOrder']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerNum']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierNum']) as number | null,
      sharpe_ratio: this.parseNumber(raw[field_map['sharpe_ratio'] || 'sharpeRatio']),
      aum: this.parseNumber(raw[field_map['aum'] || 'aum']),
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'totalOrder',
  followers: 'followerNum',
  copiers: 'copierNum',
  sharpe_ratio: 'sharpeRatio',
  aum: 'aum',
};

interface BybitListResponse {
  result: {
    leaderList: BybitLeaderItem[];
    list?: BybitLeaderItem[];
  };
  data?: {
    list?: BybitLeaderItem[];
  };
}

interface BybitLeaderItem {
  leaderMark: string;
  leaderId: string;
  nickName: string;
  avatar: string;
  avatarUrl?: string;
  roi: number;
  pnl: number;
  winRate: number;
  maxDrawdown: number;
  totalOrder: number;
  followerNum: number;
  copierNum: number;
  aum: number;
}
