/**
 * Binance Futures Copy Trading Connector
 *
 * Source: https://www.binance.com/en/copy-trading
 * API: Internal bapi endpoints (public, no auth required)
 * Windows: 7D, 30D, 90D supported via periodType param
 * ROI Sort: Supported via sortType=ROI
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
const DETAIL_API = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`;
const PROFILE_API = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`;

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'WEEKLY',
  '30d': 'MONTHLY',
  '90d': 'QUARTER',
};

export class BinanceFuturesConnector extends BaseConnector {
  platform: Platform = 'binance';
  market_type: MarketType = 'futures';

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
        };

        const response = await this.postJSON<BinanceListResponse>(LIST_API, body, {
          'Origin': API_BASE,
          'Referer': `${API_BASE}/en/copy-trading`,
        });

        if (!response?.data?.list) break;

        for (const item of response.data.list) {
          entries.push({
            trader_key: item.leadPortfolioId || item.portfolioId || String(item.uid),
            display_name: item.nickname || null,
            avatar_url: item.userPhotoUrl || null,
            profile_url: `${API_BASE}/en/copy-trading/lead-details/${item.leadPortfolioId}`,
            rank: entries.length + 1,
            metrics: this.normalize(item as unknown as Record<string, unknown>, FIELD_MAP),
            raw: item as unknown as Record<string, unknown>,
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
      return this.failure(`Binance Futures leaderboard fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const response = await this.postJSON<BinanceProfileResponse>(PROFILE_API, {
        portfolioId: trader_key,
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/copy-trading/lead-details/${trader_key}`,
      });

      if (!response?.data) {
        return this.failure('Profile not found');
      }

      const d = response.data;
      return this.success<CanonicalProfile>({
        platform: 'binance',
        market_type: 'futures',
        trader_key,
        display_name: d.nickname || null,
        avatar_url: d.userPhotoUrl || null,
        bio: d.introduction || null,
        tags: d.tags || [],
        profile_url: `${API_BASE}/en/copy-trading/lead-details/${trader_key}`,
        followers: this.parseNumber(d.followerCount) as number | null,
        copiers: this.parseNumber(d.copierCount) as number | null,
        aum: this.parseNumber(d.totalMarginBalance) as number | null,
        provenance: this.buildProvenance(PROFILE_API),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const response = await this.postJSON<BinancePerformanceResponse>(DETAIL_API, {
        portfolioId: trader_key,
        timeRange: WINDOW_MAP[window],
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/copy-trading/lead-details/${trader_key}`,
      });

      if (!response?.data) {
        return this.failure('Snapshot not found');
      }

      const metrics = this.normalize(response.data as unknown as Record<string, unknown>, FIELD_MAP);
      const quality_flags = this.buildQualityFlags(metrics);

      return this.success<CanonicalSnapshot>({
        platform: 'binance',
        market_type: 'futures',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics: metrics as SnapshotMetrics,
        quality_flags,
        provenance: this.buildProvenance(DETAIL_API, {
          platform_sorting: 'roi_desc',
          platform_window: window,
        }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    // Binance provides equity curve data via a separate endpoint
    try {
      const url = `${API_BASE}/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance-chart`;
      const response = await this.postJSON<BinanceChartResponse>(url, {
        portfolioId: trader_key,
        timeRange: 'ALL',
      }, {
        'Origin': API_BASE,
        'Referer': `${API_BASE}/en/copy-trading/lead-details/${trader_key}`,
      });

      if (!response?.data?.chartData) {
        return this.success([], { source_url: url });
      }

      const timeseries: CanonicalTimeseries[] = [{
        platform: 'binance',
        market_type: 'futures',
        trader_key,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: response.data.chartData.map((point: { timestamp: number; value: number }) => ({
          ts: new Date(point.timestamp).toISOString(),
          value: point.value,
        })),
        provenance: this.buildProvenance(url),
      }];

      return this.success(timeseries);
    } catch (error) {
      return this.failure(`Timeseries fetch failed: ${(error as Error).message}`);
    }
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
      sharpe_ratio: this.parseNumber(raw[field_map['sharpe_ratio'] || 'sharpeRatio']),
      aum: this.parseNumber(raw[field_map['aum'] || 'totalMarginBalance']),
    };
  }
}

// ============================================
// Field Mapping
// ============================================

const FIELD_MAP: Record<string, string> = {
  roi_pct: 'roi',
  pnl_usd: 'pnl',
  win_rate: 'winRate',
  max_drawdown: 'maxDrawdown',
  trades_count: 'tradeCount',
  followers: 'followerCount',
  copiers: 'copierCount',
  sharpe_ratio: 'sharpeRatio',
  aum: 'totalMarginBalance',
};

// ============================================
// Binance Response Types
// ============================================

interface BinanceListResponse {
  data: {
    list: BinanceTraderItem[];
    total: number;
  };
}

interface BinanceTraderItem {
  leadPortfolioId: string;
  portfolioId: string;
  uid: number;
  nickname: string;
  userPhotoUrl: string;
  roi: number;
  pnl: number;
  winRate: number;
  maxDrawdown: number;
  tradeCount: number;
  followerCount: number;
  copierCount: number;
  totalMarginBalance: number;
  sharpeRatio: number;
}

interface BinanceProfileResponse {
  data: {
    nickname: string;
    userPhotoUrl: string;
    introduction: string;
    tags: string[];
    followerCount: number;
    copierCount: number;
    totalMarginBalance: number;
  };
}

interface BinancePerformanceResponse {
  data: Record<string, unknown>;
}

interface BinanceChartResponse {
  data: {
    chartData: Array<{ timestamp: number; value: number }>;
  };
}
