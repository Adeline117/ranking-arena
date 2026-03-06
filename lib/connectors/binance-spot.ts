/**
 * Binance Spot copy trading connector.
 * Similar to Binance Futures but uses spot-specific API endpoints.
 *
 * Data source: Public spot copy trading leaderboard.
 * API: /bapi/futures/v1/friendly/future/spot-copy-trade/
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
  LegacyPlatformConnector,
} from '@/lib/types/leaderboard';
import {
  BinanceSpotListResponseSchema,
  warnValidate,
} from './schemas';

// ============================================
// Binance Spot API types
// ============================================

interface BinanceSpotEntry {
  portfolioId: string;
  encryptedUid?: string;
  nickName?: string;
  userPhotoUrl?: string;
  roi?: number;
  pnl?: number;
  winRate?: number;
  followerCount?: number;
  copierCount?: number;
  maxDrawdown?: number;
}

interface BinanceSpotListResponse {
  data: {
    list: BinanceSpotEntry[];
    total?: number;
  };
  success: boolean;
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
// Connector
// ============================================

export class BinanceSpotConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'binance_spot' as const;
  private readonly baseUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];

    const raw = await this.requestWithCircuitBreaker<BinanceSpotListResponse>(
      () => this.fetchLeaderboardPage(period, 1, 100),
      { label: `discoverLeaderboard(${window})` },
    );
    const data = warnValidate(BinanceSpotListResponseSchema, raw, 'binance-spot/leaderboard') as unknown as BinanceSpotListResponse;

    if (!data.success || !data.data?.list?.length) return traders;

    for (const entry of data.data.list) {
      const id = entry.portfolioId || entry.encryptedUid;
      if (!id) continue;

      traders.push({
        platform: this.platform,
        trader_key: id,
        display_name: entry.nickName || null,
        avatar_url: entry.userPhotoUrl || null,
        profile_url: `https://www.binance.com/en/copy-trading/lead-details/${id}?type=spot`,
        discovered_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
    }

    return traders;
  }

  async fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshotLegacy, 'id' | 'created_at'>> {
    const detail = await this.requestWithCircuitBreaker<{ data: BinanceSpotEntry; success: boolean }>(
      () => this.fetchDetailApi(traderKey, window),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const d = detail.data || {};

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: d.roi != null ? d.roi * 100 : null,
      pnl_usd: d.pnl ?? null,
      win_rate_pct: d.winRate != null ? d.winRate * 100 : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) * 100 : null,
      trades_count: null, // Spot API may not provide this
      copier_count: d.copierCount ?? d.followerCount ?? null,
      sharpe_ratio: null,
      sortino_ratio: null,
      volatility_pct: null,
      avg_holding_hours: null,
      profit_factor: null,
      arena_score: null,
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

  async fetchTraderProfile(
    traderKey: string,
  ): Promise<Omit<TraderProfileEnriched, 'last_enriched_at'>> {
    const detail = await this.requestWithCircuitBreaker<{ data: BinanceSpotEntry & { introduction?: string }; success: boolean }>(
      () => this.fetchDetailApi(traderKey, '90d'),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const d = detail.data || {};

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.userPhotoUrl || null,
      bio: (d as { introduction?: string }).introduction || null,
      copier_count: d.copierCount ?? d.followerCount ?? null,
      aum_usd: null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    // Binance Spot may not have a public performance curve API
    return {
      platform: this.platform,
      trader_key: traderKey,
      series_type: seriesType,
      data: [],
      as_of_ts: this.getDateBucket(),
    };
  }

  // ============================================
  // Private
  // ============================================

  private async fetchLeaderboardPage(
    period: string,
    page: number,
    pageSize: number,
  ): Promise<BinanceSpotListResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/common/home-page-list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUA(),
        },
        body: JSON.stringify({
          pageNumber: page,
          pageSize,
          timeRange: period,
          dataType: 'ROI',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Binance Spot API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchDetailApi(
    portfolioId: string,
    window: RankingWindow,
  ): Promise<{ data: BinanceSpotEntry; success: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/common/portfolio-detail`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': this.getRandomUA(),
        },
        body: JSON.stringify({
          portfolioId,
          timeRange: WINDOW_TO_PERIOD[window],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Binance Spot detail API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private getRandomUA(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}
