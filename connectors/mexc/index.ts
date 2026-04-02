/**
 * MEXC Copy Trading Connector
 *
 * Source: https://www.mexc.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via sortBy=roi
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.mexc.com';
const LIST_API = `${API_BASE}/api/platform/copy-trade/trader/list`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7',
  '30d': '30',
  '90d': '90',
};

export class MexcConnector extends BaseConnector {
  platform: Platform = 'mexc';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 15, concurrent: 1, delay_ms: 4000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first
        const vpsResponse = await this.fetchViaVPS<any>('/mexc/leaderboard', {
          page,
          pageSize,
          periodDays: WINDOW_MAP[window],
        });

        let traderList: any[] = [];

        if (vpsResponse) {
          // VPS scraper returns: { code, data: { goldTraders: [...], silverTraders: [...], ... } }
          const vpsData = vpsResponse.data || vpsResponse;
          const allTraders = [
            ...(vpsData.goldTraders || []),
            ...(vpsData.silverTraders || []),
            ...(vpsData.bullsTraders || []),
            ...(vpsData.bearsTraders || []),
          ];
          traderList = allTraders.slice(0, pageSize);
        } else {
          // Fallback to direct API
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            sortBy: 'roi',
            sortType: 'DESC',
            periodDays: WINDOW_MAP[window],
          });

          const response = await this.fetchJSON<MexcListResponse>(
            `${LIST_API}?${params.toString()}`,
            {
              headers: {
                'Referer': `${API_BASE}/copy-trading`,
                'Origin': API_BASE,
              },
            }
          );

          if (!response?.data?.list) break;
          traderList = response.data.list;
        }

        if (traderList.length === 0) break;

        for (const item of traderList) {
          entries.push({
            trader_key: item.traderId || item.uid,
            display_name: item.nickName || null,
            avatar_url: item.avatar || null,
            profile_url: `${API_BASE}/copy-trading/trader/${item.traderId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (traderList.length < pageSize) break;
        await this.sleep(this.getRandomDelay(3000, 5000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`MEXC leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/api/platform/copy-trade/trader/detail?traderId=${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE, 'Referer': `${API_BASE}/copy-trading/trader/${trader_key}` },
      });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'mexc',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatar as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/trader/${trader_key}`,
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
      const url = `${API_BASE}/api/platform/copy-trade/trader/performance?traderId=${trader_key}&periodDays=${WINDOW_MAP[window]}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Snapshot not found');
      const metrics = this.normalize(response.data, FIELD_MAP);

      return this.success<CanonicalSnapshot>({
        platform: 'mexc',
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

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'MEXC timeseries not publicly available' });
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] ?? raw.roiRate),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'totalOrder']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerCount']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierCount']) as number | null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'totalOrder',
  followers: 'followerCount',
  copiers: 'copierCount',
};

interface MexcListResponse {
  data: { list: MexcTraderItem[] };
}

interface MexcTraderItem {
  traderId: string;
  uid: string;
  nickName: string;
  avatar: string;
  roi: number;
}
