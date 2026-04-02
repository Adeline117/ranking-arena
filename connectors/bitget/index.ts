/**
 * Bitget Copy Trading Connector (Futures + Spot)
 *
 * Source: https://www.bitget.com/copy-trading
 * API: Public v2 copy trade endpoints
 * Windows: 7D, 30D, 90D via periodType
 * ROI Sort: Supported via sortBy=ROI
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.bitget.com';
const LIST_API = `${API_BASE}/v1/trigger/trace/queryCopyTraderList`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
};

export class BitgetFuturesConnector extends BaseConnector {
  platform: Platform = 'bitget';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 20, concurrent: 2, delay_ms: 3000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first (bypasses WAF)
        const vpsResponse = await this.fetchViaVPS<BitgetListResponse>('/bitget/leaderboard', {
          page,
          pageSize,
          period: WINDOW_MAP[window],
          type: 'futures',
        });

        let traderList: BitgetTraderItem[] = [];

        if (vpsResponse?.data?.traderList) {
          traderList = vpsResponse.data.traderList;
        } else {
          // Fallback to direct API (likely to fail with 403)
          const body = {
            pageNo: page,
            pageSize,
            periodType: WINDOW_MAP[window],
            sortBy: 'ROI',
            sortType: 'DESC',
            productType: 'USDT-FUTURES',
          };

          const response = await this.postJSON<BitgetListResponse>(LIST_API, body, {
            'Origin': API_BASE,
            'Referer': `${API_BASE}/copy-trading`,
            'language': 'en_US',
          });

          if (response?.data?.traderList) {
            traderList = response.data.traderList;
          }
        }

        if (traderList.length === 0) break;

        for (const item of traderList) {
          entries.push({
            trader_key: item.traderId || item.traderUid,
            display_name: item.nickName || item.traderName || null,
            avatar_url: item.headUrl || item.avatar || null,
            profile_url: `${API_BASE}/copy-trading/trader/detail/${item.traderId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (traderList.length < pageSize) break;
        await this.sleep(this.getRandomDelay(2000, 4000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Bitget Futures leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/v1/trigger/trace/queryTraderDetail`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        traderId: trader_key,
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/copy-trading/trader/detail/${trader_key}`,
      });

      if (!response?.data) return this.failure('Profile not found');

      const d = response.data;
      return this.success<CanonicalProfile>({
        platform: 'bitget',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || (d.traderName as string) || null,
        avatar_url: (d.headUrl as string) || null,
        bio: (d.introduction as string) || null,
        tags: (d.tags as string[]) || [],
        profile_url: `${API_BASE}/copy-trading/trader/detail/${trader_key}`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: this.parseNumber(d.totalAssets) as number | null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/v1/trigger/trace/queryTraderPerformance`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        traderId: trader_key,
        periodType: WINDOW_MAP[window],
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/copy-trading/trader/detail/${trader_key}`,
      });

      if (!response?.data) return this.failure('Snapshot not found');

      const metrics = this.normalize(response.data, FIELD_MAP);
      return this.success<CanonicalSnapshot>({
        platform: 'bitget',
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
      // Bitget www endpoints are behind CF; try proxy if available
      const proxyUrl = process.env.CLOUDFLARE_PROXY_URL;
      if (!proxyUrl) {
        return this.success([], { reason: 'Bitget timeseries requires CLOUDFLARE_PROXY_URL' });
      }

      const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${trader_key}`;
      const response = await this.fetchJSON<{ data?: Array<{ date: string; profit?: number; profitRate?: number }> }>(
        `${proxyUrl}?url=${encodeURIComponent(targetUrl)}`,
      );

      if (!response?.data?.length) return this.success([]);

      return this.success<CanonicalTimeseries[]>([{
        platform: 'bitget',
        market_type: 'futures',
        trader_key,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: response.data.filter(p => p.date).map(p => ({
          ts: p.date,
          value: p.profitRate != null ? Number(p.profitRate) * 100 : 0,
          pnl: p.profit != null ? Number(p.profit) : 0,
        })),
        provenance: this.buildProvenance(targetUrl),
      }]);
    } catch (error) {
      return this.success([], { reason: `Bitget timeseries failed: ${(error as Error).message}` });
    }
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] ?? raw.yieldRate ?? raw.roiRate),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'profit']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'totalOrder']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerCount']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierCount']) as number | null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw[field_map['aum'] || 'totalAssets']),
    };
  }
}

export class BitgetSpotConnector extends BaseConnector {
  platform: Platform = 'bitget';
  market_type: MarketType = 'spot';

  protected rate_limit = { rpm: 20, concurrent: 2, delay_ms: 3000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first (bypasses WAF)
        const vpsResponse = await this.fetchViaVPS<BitgetListResponse>('/bitget/leaderboard', {
          page,
          pageSize,
          period: WINDOW_MAP[window],
          type: 'spot',
        });

        let traderList: BitgetTraderItem[] = [];

        if (vpsResponse?.data?.traderList) {
          traderList = vpsResponse.data.traderList;
        } else {
          // Fallback to direct API (likely to fail with 403)
          const body = {
            pageNo: page,
            pageSize,
            periodType: WINDOW_MAP[window],
            sortBy: 'ROI',
            sortType: 'DESC',
            productType: 'SPOT',
          };

          const response = await this.postJSON<BitgetListResponse>(LIST_API, body, {
            'Origin': API_BASE,
            'Referer': `${API_BASE}/copy-trading/spot`,
            'language': 'en_US',
          });

          if (response?.data?.traderList) {
            traderList = response.data.traderList;
          }
        }

        if (traderList.length === 0) break;

        for (const item of traderList) {
          entries.push({
            trader_key: item.traderId || item.traderUid,
            display_name: item.nickName || item.traderName || null,
            avatar_url: item.headUrl || item.avatar || null,
            profile_url: `${API_BASE}/copy-trading/trader/detail/${item.traderId}?type=spot`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (traderList.length < pageSize) break;
        await this.sleep(this.getRandomDelay(2000, 4000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Bitget Spot leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/v1/trigger/trace/queryTraderDetail`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        traderId: trader_key,
        productType: 'SPOT',
      }, { 'Origin': API_BASE });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'bitget',
        market_type: 'spot',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.headUrl as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/trader/detail/${trader_key}?type=spot`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/v1/trigger/trace/queryTraderPerformance`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        traderId: trader_key,
        periodType: WINDOW_MAP[window],
        productType: 'SPOT',
      }, { 'Origin': API_BASE });

      if (!response?.data) return this.failure('Snapshot not found');
      const metrics = this.normalize(response.data, FIELD_MAP);

      return this.success<CanonicalSnapshot>({
        platform: 'bitget',
        market_type: 'spot',
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

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Bitget Spot timeseries not available' });
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] ?? raw.yieldRate ?? raw.roiRate),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'profit']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'totalOrder']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerCount']) as number | null,
      copiers: null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'profit',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'totalOrder',
  followers: 'followerCount',
  copiers: 'copierCount',
  aum: 'totalAssets',
};

interface BitgetListResponse {
  data: {
    traderList: BitgetTraderItem[];
  };
}

interface BitgetTraderItem {
  traderId: string;
  traderUid: string;
  nickName: string;
  traderName: string;
  headUrl: string;
  avatar: string;
  roi: number;
  yieldRate: number;
}
