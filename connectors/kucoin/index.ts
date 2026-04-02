/**
 * KuCoin Copy Trading Connector
 *
 * Source: https://www.kucoin.com/copy-trading
 * API: Public copy trade leader ranking
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via sortBy=ROI
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.kucoin.com';
const LIST_API = `${API_BASE}/_api/copy-trade/leader/ranking`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'WEEK',
  '30d': 'MONTH',
  '90d': 'QUARTER',
};

export class KucoinConnector extends BaseConnector {
  platform: Platform = 'kucoin';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 15, concurrent: 1, delay_ms: 4000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first
        const vpsResponse = await this.fetchViaVPS<KucoinListResponse>('/kucoin/leaderboard', {
          page,
          pageSize,
          period: WINDOW_MAP[window],
        });

        let items: KucoinTraderItem[] = [];

        if (vpsResponse?.data?.items) {
          items = vpsResponse.data.items;
        } else {
          // Fallback to direct API
          const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            sortBy: 'ROI',
            sortOrder: 'DESC',
            period: WINDOW_MAP[window],
          });

          const response = await this.fetchJSON<KucoinListResponse>(
            `${LIST_API}?${params.toString()}`,
            {
              headers: {
                'Referer': `${API_BASE}/copy-trading`,
                'Origin': API_BASE,
              },
            }
          );

          if (response?.data?.items) {
            items = response.data.items;
          }
        }

        if (items.length === 0) break;

        for (const item of items) {
          entries.push({
            trader_key: item.leaderId || item.uid,
            display_name: item.nickName || null,
            avatar_url: item.avatar || null,
            profile_url: `${API_BASE}/copy-trading/leader/${item.leaderId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (items.length < pageSize) break;
        await this.sleep(this.getRandomDelay(3000, 5000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`KuCoin leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/_api/copy-trade/leader/detail?leaderId=${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'kucoin',
        market_type: 'futures',
        trader_key,
        display_name: (d.nickName as string) || null,
        avatar_url: (d.avatar as string) || null,
        bio: (d.description as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/leader/${trader_key}`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: this.parseNumber(d.aum) as number | null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/_api/copy-trade/leader/performance?leaderId=${trader_key}&period=${WINDOW_MAP[window]}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Snapshot not found');
      const metrics = this.normalize(response.data, FIELD_MAP);

      return this.success<CanonicalSnapshot>({
        platform: 'kucoin',
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
    return this.success([], { reason: 'KuCoin timeseries not publicly available' });
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] ?? raw.roiRate),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw.totalOrders) as number | null,
      followers: this.parseNumber(raw.followerCount) as number | null,
      copiers: this.parseNumber(raw.copierCount) as number | null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw.aum),
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'totalOrders',
  followers: 'followerCount',
  copiers: 'copierCount',
};

interface KucoinListResponse {
  data: { items: KucoinTraderItem[] };
}

interface KucoinTraderItem {
  leaderId: string;
  uid: string;
  nickName: string;
  avatar: string;
}
