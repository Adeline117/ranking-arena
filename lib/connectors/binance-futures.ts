/**
 * Binance Futures copy trading connector.
 * Fetches public leaderboard data from Binance's copy trading API.
 *
 * Data source: Public copy trading leaderboard (no auth required).
 * Rate limits: Conservative 30 req/min with 2-5s jitter.
 */

import { BaseConnectorLegacy } from './base';
import type {
  RankingWindow,
  TraderIdentity,
  TraderSnapshotLegacy,
  TraderProfileEnriched,
  TraderTimeseriesLegacy,
  TimeseriesType,
  SnapshotMetricsLegacy,
  TimeseriesPoint,
  LegacyPlatformConnector,
} from '@/lib/types/leaderboard';
import {
  BinanceLeaderboardResponseSchema,
  BinanceTraderDetailWrapperSchema,
  BinancePerformanceResponseSchema,
  warnValidate,
} from './schemas';

// ============================================
// Binance API types (internal)
// ============================================

interface BinanceLeaderboardEntry {
  encryptedUid: string;
  nickName: string;
  userPhotoUrl: string;
  rank: number;
  roi: number;
  pnl: number;
  winRate?: number;
  followerCount?: number;
  copierCount?: number;
}

interface BinanceLeaderboardResponse {
  data: BinanceLeaderboardEntry[];
  total: number;
  success: boolean;
}

interface BinanceTraderDetail {
  encryptedUid: string;
  nickName: string;
  userPhotoUrl: string;
  introduction?: string;
  followerCount?: number;
  copierCount?: number;
  aum?: number;
  createTime?: number;
  roi?: number;
  pnl?: number;
  winRate?: number;
  maxDrawdown?: number;
  tradeCount?: number;
  avgHoldingTime?: number;
  sharpeRatio?: number;
}

interface BinancePerformanceEntry {
  time: number; // unix ms
  value: number;
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_PERIOD: Record<RankingWindow, string> = {
  '7d': 'WEEKLY',
  '30d': 'MONTHLY',
  '90d': 'QUARTERLY',
};

// ============================================
// Connector Implementation
// ============================================

export class BinanceFuturesConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'binance_futures' as const;
  private readonly baseUrl = 'https://www.binance.com/bapi/futures/v1/public/future/copy-trade';

  constructor() {
    super();
    this.init();
  }

  /**
   * Discover traders from Binance futures copy trading leaderboard.
   * Fetches multiple pages to build a comprehensive list.
   */
  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];
    const pageSize = 20;
    const maxPages = 5; // 100 traders per window

    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.requestWithCircuitBreaker<BinanceLeaderboardResponse>(
        () => this.fetchLeaderboardPage(period, page, pageSize),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );
      const data = warnValidate(BinanceLeaderboardResponseSchema, raw, 'binance/leaderboard') as unknown as BinanceLeaderboardResponse;

      if (!data.success || !data.data?.length) break;

      for (const entry of data.data) {
        traders.push({
          platform: this.platform,
          trader_key: entry.encryptedUid,
          display_name: entry.nickName || null,
          avatar_url: entry.userPhotoUrl || null,
          profile_url: `https://www.binance.com/en/copy-trading/lead-details/${entry.encryptedUid}`,
          discovered_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });
      }
    }

    return traders;
  }

  /**
   * Fetch performance snapshot for a single trader.
   */
  async fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshotLegacy, 'id' | 'created_at'>> {
    const detail = await this.requestWithCircuitBreaker<BinanceTraderDetail>(
      () => this.fetchTraderDetailApi(traderKey, window),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: detail.roi ?? null,
      pnl_usd: detail.pnl ?? null,
      win_rate_pct: detail.winRate != null ? detail.winRate * 100 : null,
      max_drawdown_pct: detail.maxDrawdown != null ? Math.abs(detail.maxDrawdown) : null,
      trades_count: detail.tradeCount ?? null,
      copier_count: detail.copierCount ?? null,
      sharpe_ratio: detail.sharpeRatio ?? null,
      sortino_ratio: null, // Binance doesn't provide this
      volatility_pct: null,
      avg_holding_hours: detail.avgHoldingTime ?? null,
      profit_factor: null,
      arena_score: null, // Calculated server-side
      return_score: null,
      drawdown_score: null,
      stability_score: null,
    };

    return {
      platform: this.platform,
      trader_key: traderKey,
      window,
      as_of_ts: this.getDateBucket(),
      metrics,
      quality: this.buildQuality(metrics),
    };
  }

  /**
   * Fetch enriched profile data.
   */
  async fetchTraderProfile(
    traderKey: string,
  ): Promise<Omit<TraderProfileEnriched, 'last_enriched_at'>> {
    const detail = await this.requestWithCircuitBreaker<BinanceTraderDetail>(
      () => this.fetchTraderDetailApi(traderKey, '90d'),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: detail.nickName || null,
      avatar_url: detail.userPhotoUrl || null,
      bio: detail.introduction || null,
      copier_count: detail.copierCount ?? null,
      aum_usd: detail.aum ?? null,
      active_since: detail.createTime
        ? new Date(detail.createTime).toISOString().split('T')[0]
        : null,
      platform_tier: null,
    };
  }

  /**
   * Fetch timeseries (equity curve).
   */
  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    if (seriesType !== 'equity_curve' && seriesType !== 'daily_pnl') {
      // Binance only provides equity curve and daily PnL
      return {
        platform: this.platform,
        trader_key: traderKey,
        series_type: seriesType,
        data: [],
        as_of_ts: this.getDateBucket(),
      };
    }

    const entries = await this.requestWithCircuitBreaker<BinancePerformanceEntry[]>(
      () => this.fetchPerformanceCurve(traderKey, seriesType),
      { label: `fetchTimeseries(${traderKey}, ${seriesType})` },
    );

    const data: TimeseriesPoint[] = entries.map((e) => ({
      ts: new Date(e.time).toISOString(),
      value: e.value,
    }));

    return {
      platform: this.platform,
      trader_key: traderKey,
      series_type: seriesType,
      data,
      as_of_ts: this.getDateBucket(),
    };
  }

  // ============================================
  // Private API methods
  // ============================================

  private async fetchLeaderboardPage(
    period: string,
    page: number,
    pageSize: number,
  ): Promise<BinanceLeaderboardResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/lead-portfolio/ranking`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUserAgent(),
        },
        body: JSON.stringify({
          pageNumber: page,
          pageSize,
          timeRange: period,
          dataType: 'ROI',
          favoriteOnly: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Binance leaderboard API returned ${response.status}`,
        );
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTraderDetailApi(
    encryptedUid: string,
    window: RankingWindow,
  ): Promise<BinanceTraderDetail> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/lead-portfolio/detail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUserAgent(),
        },
        body: JSON.stringify({
          encryptedUid,
          timeRange: WINDOW_TO_PERIOD[window],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Binance trader detail API returned ${response.status}`,
        );
      }

      const json = await response.json();
      const validated = warnValidate(BinanceTraderDetailWrapperSchema, json, 'binance/trader-detail');
      if (!validated.success || !validated.data) {
        throw new Error(
          `Binance trader detail API returned no data for ${encryptedUid}`,
        );
      }

      return validated.data as unknown as BinanceTraderDetail;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchPerformanceCurve(
    encryptedUid: string,
    type: 'equity_curve' | 'daily_pnl',
  ): Promise<BinancePerformanceEntry[]> {
    const dataType = type === 'equity_curve' ? 'ROI' : 'PNL';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl}/lead-portfolio/performance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUserAgent(),
        },
        body: JSON.stringify({
          encryptedUid,
          dataType,
          timeRange: 'QUARTERLY', // Always fetch 90d for full picture
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Binance performance API returned ${response.status}`,
        );
      }

      const json = await response.json();
      const validated = warnValidate(BinancePerformanceResponseSchema, json, 'binance/performance');
      return validated.data || [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private getRandomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}
