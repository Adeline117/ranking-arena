/**
 * CoinEx Copy Trading Connector
 *
 * Source: https://www.coinex.com/copy-trading
 * API: Public copy trade endpoints
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via order_by=roi
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.coinex.com';
const LIST_API = `${API_BASE}/res/copy-trading/traders`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': '7',
  '30d': '30',
  '90d': '90',
};

export class CoinexConnector extends BaseConnector {
  platform: Platform = 'coinex';
  market_type: MarketType = 'futures';

  protected rate_limit = { rpm: 15, concurrent: 1, delay_ms: 4000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        // Try VPS scraper first
        const vpsResponse = await this.fetchViaVPS<CoinexVPSResponse>('/coinex/leaderboard', {
          page,
          pageSize,
          period: WINDOW_MAP[window],
        });

        let traders: CoinexTraderItem[] = [];

        if (vpsResponse?.data?.data) {
          // VPS scraper returns: { data: { data: [...] } }
          // Map VPS response to connector format
          traders = vpsResponse.data.data.map((item: Record<string, unknown>): CoinexTraderItem => ({
            trader_id: String(item.trader_id || item.uid || item.user_id || ''),
            nick_name: String(item.nickname || item.nick_name || item.account_name || ''),
            avatar: String(item.avatar || item.avatar_url || ''),
            roi: this.parseNumber(item.profit_rate || item.roi || item.roiRate) as number,
            win_rate: this.parseNumber(item.winning_rate || item.win_rate || item.winRate) as number,
            pnl: this.parseNumber(item.profit_amount || item.pnl || item.profit) as number,
            trade_count: this.parseNumber(item.trade_count || item.tradeCount) as number,
            aum: this.parseNumber(item.aum || item.total_assets) as number,
            max_drawdown: this.parseNumber(item.mdd || item.max_drawdown || item.maxDrawdown) as number,
            raw: item,
          }));
        } else if (vpsResponse?.data?.items) {
          // Alternative VPS format
          traders = vpsResponse.data.items;
        } else {
          // Fallback to direct API
          const params = new URLSearchParams({
            page: String(page),
            limit: String(pageSize),
            order_by: 'roi',
            order_type: 'desc',
            days: WINDOW_MAP[window],
          });

          const apiResponse = await this.fetchJSON<CoinexListResponse>(
            `${LIST_API}?${params.toString()}`,
            {
              headers: {
                'Referer': `${API_BASE}/copy-trading`,
                'Origin': API_BASE,
              },
            }
          );

          if (apiResponse?.data?.items) {
            traders = apiResponse.data.items;
          }
        }

        if (traders.length === 0) break;

        for (const item of traders) {
          entries.push({
            trader_key: item.trader_id || String(item.user_id),
            display_name: item.nick_name || null,
            avatar_url: item.avatar || null,
            profile_url: `${API_BASE}/copy-trading/trader/${item.trader_id}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
          });
        }

        if (traders.length < pageSize) break;
        await this.sleep(this.getRandomDelay(3000, 5000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`CoinEx leaderboard failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/res/copy-trading/trader/${trader_key}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Profile not found');
      const d = response.data;

      return this.success<CanonicalProfile>({
        platform: 'coinex',
        market_type: 'futures',
        trader_key,
        display_name: (d.nick_name as string) || null,
        avatar_url: (d.avatar as string) || null,
        bio: (d.introduction as string) || null,
        tags: [],
        profile_url: `${API_BASE}/copy-trading/trader/${trader_key}`,
        followers: this.parseNumber(d.follower_count) as number | null,
        copiers: this.parseNumber(d.copier_count) as number | null,
        aum: null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/res/copy-trading/trader/${trader_key}/performance?days=${WINDOW_MAP[window]}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown> }>(url, {
        headers: { 'Origin': API_BASE },
      });

      if (!response?.data) return this.failure('Snapshot not found');
      const metrics = this.normalize(response.data, FIELD_MAP);

      return this.success<CanonicalSnapshot>({
        platform: 'coinex',
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
    return this.success([], { reason: 'CoinEx timeseries not publicly available' });
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi'] ?? raw.roi_rate),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'win_rate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'max_drawdown']),
      trades_count: this.parseNumber(raw.trade_count) as number | null,
      followers: this.parseNumber(raw.follower_count) as number | null,
      copiers: this.parseNumber(raw.copier_count) as number | null,
      sharpe_ratio: null,
      aum: null,
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'win_rate',
  max_drawdown: 'max_drawdown',
  trades_count: 'trade_count',
  followers: 'follower_count',
  copiers: 'copier_count',
};

interface CoinexListResponse {
  data: { items: CoinexTraderItem[] };
}

interface CoinexVPSResponse {
  data: {
    data?: Record<string, unknown>[];
    items?: CoinexTraderItem[];
  };
}

interface CoinexTraderItem {
  trader_id: string;
  user_id?: number;
  nick_name: string;
  avatar: string;
  roi: number;
  win_rate?: number;
  pnl?: number;
  trade_count?: number;
  aum?: number;
  max_drawdown?: number;
  raw?: Record<string, unknown>;
}
