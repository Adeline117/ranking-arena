/**
 * Bybit Copy Trading Connector (WITH PROXY)
 * 
 * This version uses Cloudflare Worker proxy to bypass Akamai WAF blocking.
 * Fallback chain:
 * 1. Cloudflare Worker /bybit/copy-trading endpoint
 * 2. Direct api2.bybit.com (if proxy unavailable)
 * 3. Generic /proxy endpoint
 *
 * Source: https://www.bybit.com/copyTrading/traderRanking
 * API: Public v1 copy trade endpoints (via Cloudflare Worker)
 * Windows: 7D, 30D, 90D via dataDuration
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://api2.bybit.com';
const PROXY_BASE = process.env.CLOUDFLARE_PROXY_URL || '';

// Cloudflare Worker shortcut endpoints
const PROXY_LEADERBOARD = `${PROXY_BASE}/bybit/copy-trading`;

// Direct API endpoints (fallback)
const LIST_URL = `${API_BASE}/fapi/beehive/public/v1/common/dynamic-leader-list`;
const PROFILE_URL = `${API_BASE}/fapi/beehive/public/v1/common/leader-details`;
const PERFORMANCE_URL = `${API_BASE}/fapi/beehive/public/v1/common/leader-performance`;
const EQUITY_URL = `${API_BASE}/fapi/beehive/public/v1/common/leader/equity-curve`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'DATA_DURATION_SEVEN_DAY',
  '30d': 'DATA_DURATION_THIRTY_DAY',
  '90d': 'DATA_DURATION_NINETY_DAY',
};

export class BybitProxyConnector extends BaseConnector {
  platform: Platform = 'bybit';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 30, concurrent: 3, delay_ms: 2000 };

  private async fetchViaProxy<T>(endpoint: string, params: Record<string, string | number>): Promise<T | null> {
    if (!PROXY_BASE) return null;

    try {
      const queryString = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ).toString();
      const url = `${endpoint}?${queryString}`;

      console.warn(`[Bybit] Trying proxy: ${url}`);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.warn(`[Bybit] Proxy returned ${response.status}`);
        return null;
      }

      const data = await response.json() as T;
      console.warn(`[Bybit] ✅ Proxy success`);
      return data;
    } catch (error) {
      console.warn(`[Bybit] Proxy failed:`, (error as Error).message);
      return null;
    }
  }

  private async fetchDirectly<T>(url: string, options: RequestInit): Promise<T | null> {
    try {
      console.warn(`[Bybit] Trying direct: ${url}`);
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.warn(`[Bybit] Direct returned ${response.status}`);
        return null;
      }

      const data = await response.json() as T;
      console.warn(`[Bybit] ✅ Direct success`);
      return data;
    } catch (error) {
      console.warn(`[Bybit] Direct failed:`, (error as Error).message);
      return null;
    }
  }

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 50;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        const params = {
          pageNo: page,
          pageSize: pageSize,
          period: WINDOW_MAP[window],
        };

        // Try proxy first
        let response = await this.fetchViaProxy<BybitListResponse>(PROXY_LEADERBOARD, params);

        // Fallback to direct API if proxy failed
        if (!response) {
          const body = {
            pageNo: page,
            pageSize: pageSize,
            dataDuration: WINDOW_MAP[window],
            sortField: 'LEADER_SORT_FIELD_SORT_ROI',
            sortType: 'SORT_TYPE_DESC',
          };

          response = await this.fetchDirectly<BybitListResponse>(LIST_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': this.getRandomUserAgent(),
              'Accept': 'application/json',
              'Referer': 'https://www.bybit.com/copyTrade',
              'Origin': 'https://www.bybit.com',
            },
            body: JSON.stringify(body),
          });
        }

        if (!response) {
          return this.failure('Both proxy and direct API failed. Bybit may be blocking all requests.');
        }

        const list = response?.result?.dataList || response?.result?.list || [];
        if (list.length === 0) break;

        for (const item of list) {
          entries.push({
            trader_key: item.leaderMark || item.leaderId,
            display_name: item.nickName || null,
            avatar_url: item.avatar || null,
            profile_url: `https://www.bybit.com/copyTrade/tradeCenter/leaderBoard/detail?leaderMark=${item.leaderMark || item.leaderId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (list.length < pageSize) break;
        await this.sleep(this.getRandomDelay(1500, 3000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: PROXY_BASE ? PROXY_LEADERBOARD : LIST_URL,
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
        avatar_url: (d.avatar as string) || null,
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
      const body = {
        leaderId: trader_key,
        timeRange: WINDOW_MAP[window],
      };
      const response = await this.postJSON<{ result: Record<string, unknown>; data: Record<string, unknown> }>(
        PERFORMANCE_URL,
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
        provenance: this.buildProvenance(PERFORMANCE_URL, { platform_sorting: 'roi_desc', platform_window: window }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    try {
      const params = new URLSearchParams({ leaderMark: trader_key });
      const url = `${EQUITY_URL}?${params.toString()}`;
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
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] || raw['profitRate']),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl'] || raw['totalProfit']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'totalOrder'] || raw['orderCount']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerNum']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierNum']) as number | null,
      sharpe_ratio: this.parseNumber(raw[field_map['sharpe_ratio'] || 'sharpeRatio']),
      aum: this.parseNumber(raw[field_map['aum'] || 'aum'] || raw['totalAssets']),
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'profitRate',
  pnl_usd: 'totalProfit',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'orderCount',
  followers: 'followerNum',
  copiers: 'copierNum',
  sharpe_ratio: 'sharpeRatio',
  aum: 'totalAssets',
};

interface BybitListResponse {
  retCode?: number;
  retMsg?: string;
  result: {
    dataList?: BybitLeaderItem[];
    list?: BybitLeaderItem[];
  };
}

interface BybitLeaderItem {
  leaderMark: string;
  leaderId: string;
  nickName: string;
  avatar: string;
  profitRate: number;  // ROI
  totalProfit: number; // PnL
  winRate: number;
  maxDrawdown: number;
  orderCount: number;  // Total trades
  followerNum: number;
  copierNum: number;
  totalAssets: number; // AUM
}
