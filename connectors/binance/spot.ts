/**
 * Binance Spot Copy Trading Connector
 *
 * Source: https://www.binance.com/en/copy-trading/spot
 * API: Internal bapi endpoints (public, no auth required)
 * Windows: 7D, 30D, 90D
 * ROI Sort: Supported via dataType=ROI
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://www.binance.com';
const LIST_API = `${API_BASE}/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'WEEKLY',
  '30d': 'MONTHLY',
  '90d': 'QUARTER',
};

export class BinanceSpotConnector extends BaseConnector {
  platform: Platform = 'binance';
  market_type: MarketType = 'spot';

  protected rate_limit = { rpm: 20, concurrent: 2, delay_ms: 3000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const entries: LeaderboardEntry[] = [];
      const pageSize = 20;
      const pages = Math.ceil(limit / pageSize);

      for (let page = 1; page <= pages && entries.length < limit; page++) {
        const body = {
          pageNumber: page,
          pageSize,
          timeRange: WINDOW_MAP[window],
          dataType: 'ROI',
          favoriteOnly: false,
          hideFull: false,
          nickname: '',
          order: 'DESC',
          portfolioType: 'SPOT',
        };

        const response = await this.postJSON<{ data: { list: Record<string, unknown>[] } }>(LIST_API, body, {
          'Origin': API_BASE,
          'Referer': `${API_BASE}/en/copy-trading/spot`,
        });

        if (!response?.data?.list) break;

        for (const item of response.data.list) {
          entries.push({
            trader_key: String(item.leadPortfolioId || item.portfolioId || item.uid),
            display_name: (item.nickname as string) || null,
            avatar_url: (item.userPhotoUrl as string) || null,
            profile_url: `${API_BASE}/en/copy-trading/lead-details/${item.leadPortfolioId}?type=spot`,
            rank: entries.length + 1,
            metrics: this.normalize(item, FIELD_MAP),
            raw: item,
          });
        }

        if (response.data.list.length < pageSize) break;
        await this.sleep(this.getRandomDelay(2000, 4000));
      }

      return this.success(entries.slice(0, limit), {
        source_url: LIST_API,
        platform_sorting: 'roi_desc',
        platform_window: window,
      });
    } catch (error) {
      return this.failure(`Binance Spot leaderboard fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        portfolioId: trader_key,
        portfolioType: 'SPOT',
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/copy-trading/lead-details/${trader_key}?type=spot`,
      });

      if (!response?.data) return this.failure('Profile not found');

      const d = response.data;
      return this.success<CanonicalProfile>({
        platform: 'binance',
        market_type: 'spot',
        trader_key,
        display_name: (d.nickname as string) || null,
        avatar_url: (d.userPhotoUrl as string) || null,
        bio: (d.introduction as string) || null,
        tags: (d.tags as string[]) || [],
        profile_url: `${API_BASE}/en/copy-trading/lead-details/${trader_key}?type=spot`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: this.parseNumber(d.totalAsset) as number | null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`;
      const response = await this.postJSON<{ data: Record<string, unknown> }>(url, {
        portfolioId: trader_key,
        timeRange: WINDOW_MAP[window],
        portfolioType: 'SPOT',
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/copy-trading/lead-details/${trader_key}?type=spot`,
      });

      if (!response?.data) return this.failure('Snapshot not found');

      const metrics = this.normalize(response.data, FIELD_MAP);
      return this.success<CanonicalSnapshot>({
        platform: 'binance',
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

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Spot timeseries via same chart endpoint as futures' });
  }

  normalize(raw: Record<string, unknown>, field_map: Record<string, string>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw[field_map['roi_pct'] || 'roi']),
      pnl_usd: this.parseNumber(raw[field_map['pnl_usd'] || 'pnl']),
      win_rate: this.parseNumber(raw[field_map['win_rate'] || 'winRate']),
      max_drawdown: this.parseNumber(raw[field_map['max_drawdown'] || 'maxDrawdown']),
      trades_count: this.parseNumber(raw[field_map['trades_count'] || 'tradeCount']) as number | null,
      followers: this.parseNumber(raw[field_map['followers'] || 'followerCount']) as number | null,
      copiers: this.parseNumber(raw[field_map['copiers'] || 'copierCount']) as number | null,
      sharpe_ratio: null,
      aum: this.parseNumber(raw[field_map['aum'] || 'totalAsset']),
    };
  }
}

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'tradeCount',
  followers: 'followerCount',
  copiers: 'copierCount',
  aum: 'totalAsset',
};
