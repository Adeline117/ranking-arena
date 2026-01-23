/**
 * Bitget Spot copy trading connector.
 * Fetches public leaderboard data from Bitget's spot copy trading API.
 *
 * Data source: Public spot copy trading leaderboard.
 * Rate limits: 20 req/min with 2.5-5s jitter.
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

// ============================================
// Bitget Spot API types
// ============================================

interface BitgetSpotEntry {
  traderId: string;
  nickName?: string;
  avatar?: string;
  roi?: number;
  totalProfit?: number;
  winRatio?: number;
  maxDrawdown?: number;
  followerCount?: number;
  currentCopyCount?: number;
  totalTradeCount?: number;
}

interface BitgetSpotListResponse {
  code: string;
  data: {
    list: BitgetSpotEntry[];
    total?: number;
  };
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_SORT: Record<RankingWindow, number> = {
  '7d': 1,
  '30d': 2,
  '90d': 0,
};

// ============================================
// Connector
// ============================================

export class BitgetSpotConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'bitget_spot' as const;
  private readonly baseUrl = 'https://www.bitget.com/v1/copy/spot';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const sortPeriod = WINDOW_TO_SORT[window];
    const traders: TraderIdentity[] = [];

    for (let page = 1; page <= 5; page++) {
      const data = await this.requestWithCircuitBreaker<BitgetSpotListResponse>(
        () => this.fetchLeaderboardPage(sortPeriod, page, 20),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );

      if (data.code !== '0' || !data.data?.list?.length) break;

      for (const entry of data.data.list) {
        if (!entry.traderId) continue;

        traders.push({
          platform: this.platform,
          trader_key: entry.traderId,
          display_name: entry.nickName || null,
          avatar_url: entry.avatar || null,
          profile_url: `https://www.bitget.com/copytrading/trader/${entry.traderId}/spot`,
          discovered_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });
      }
    }

    return traders;
  }

  async fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshotLegacy, 'id' | 'created_at'>> {
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: BitgetSpotEntry }>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const d = detail.data || {};
    const roi = d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: roi,
      pnl_usd: d.totalProfit ?? null,
      win_rate_pct: d.winRatio != null ? (d.winRatio <= 1 ? d.winRatio * 100 : d.winRatio) : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      trades_count: d.totalTradeCount ?? null,
      copier_count: d.currentCopyCount ?? d.followerCount ?? null,
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
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: BitgetSpotEntry }>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const d = detail.data || {};

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.avatar || null,
      bio: null,
      copier_count: d.currentCopyCount ?? d.followerCount ?? null,
      aum_usd: null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
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
    sortPeriod: number,
    page: number,
    pageSize: number,
  ): Promise<BitgetSpotListResponse> {
    const url = `${this.baseUrl}/trader/list`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': this.getRandomUA(),
      },
      body: JSON.stringify({
        pageNo: page,
        pageSize,
        sortField: 'ROI',
        sortType: sortPeriod,
      }),
    });

    if (!response.ok) {
      throw new Error(`Bitget Spot API returned ${response.status}`);
    }

    return response.json();
  }

  private async fetchTraderDetailApi(traderId: string): Promise<{ code: string; data: BitgetSpotEntry }> {
    const url = `${this.baseUrl}/trader/detail?traderId=${traderId}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': this.getRandomUA() },
    });

    if (!response.ok) {
      throw new Error(`Bitget Spot detail API returned ${response.status}`);
    }

    return response.json();
  }

  private getRandomUA(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}
