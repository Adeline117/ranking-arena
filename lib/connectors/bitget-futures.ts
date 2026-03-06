/**
 * Bitget Futures copy trading connector (legacy interface).
 * Fetches public leaderboard data from Bitget's copy trading API.
 *
 * Data source: Public copy trading leaderboard (no auth required).
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
import {
  BitgetLeaderboardResponseSchema,
  BitgetTraderDetailResponseSchema,
  BitgetPerformanceResponseSchema,
  warnValidate,
} from './schemas';

// ============================================
// Bitget API types
// ============================================

interface BitgetTraderEntry {
  traderId: string;
  nickName?: string;
  avatar?: string;
  userPhoto?: string;
  roi?: number;
  totalProfit?: number;
  pnl?: number;
  winRatio?: number;
  winRate?: number;
  maxDrawdown?: number;
  mdd?: number;
  followerCount?: number;
  currentCopyCount?: number;
  tradeCount?: number;
}

interface BitgetLeaderboardResponse {
  code: string;
  data: {
    list: BitgetTraderEntry[];
    total?: number;
  };
}

interface BitgetTraderDetailResponse {
  code: string;
  data: {
    traderId: string;
    nickName?: string;
    avatar?: string;
    introduction?: string;
    followerCount?: number;
    currentCopyCount?: number;
    aum?: number;
    registerTime?: number;
    totalProfit?: number;
    roi?: number;
    winRatio?: number;
    maxDrawdown?: number;
    totalTradeCount?: number;
    avgHoldTime?: number;
    sharpeRatio?: number;
    profitDays?: number;
    lossDays?: number;
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

export class BitgetFuturesConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'bitget_futures' as const;
  private readonly baseUrl = 'https://www.bitget.com/v1/copy/mix';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const sortPeriod = WINDOW_TO_SORT[window];
    const traders: TraderIdentity[] = [];
    const pageSize = 20;
    const maxPages = 5;

    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.requestWithCircuitBreaker<BitgetLeaderboardResponse>(
        () => this.fetchLeaderboardPage(sortPeriod, page, pageSize),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );
      const data = warnValidate(BitgetLeaderboardResponseSchema, raw, 'bitget/leaderboard') as unknown as BitgetLeaderboardResponse;

      if (data.code !== '0' || !data.data?.list?.length) break;

      for (const entry of data.data.list) {
        if (!entry.traderId) continue;

        traders.push({
          platform: this.platform,
          trader_key: entry.traderId,
          display_name: entry.nickName || null,
          avatar_url: entry.avatar || entry.userPhoto || null,
          profile_url: `https://www.bitget.com/copytrading/trader/${entry.traderId}/futures`,
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
    const rawDetail = await this.requestWithCircuitBreaker<BitgetTraderDetailResponse>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );
    const detail = warnValidate(BitgetTraderDetailResponseSchema, rawDetail, 'bitget/trader-detail') as unknown as BitgetTraderDetailResponse;

    const d = detail.data || {} as BitgetTraderDetailResponse['data'];

    const roi = d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: roi,
      pnl_usd: d.totalProfit ?? null,
      win_rate_pct: d.winRatio != null
        ? (d.winRatio <= 1 ? d.winRatio * 100 : d.winRatio)
        : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      trades_count: d.totalTradeCount ?? null,
      copier_count: d.currentCopyCount ?? d.followerCount ?? null,
      sharpe_ratio: d.sharpeRatio ?? null,
      sortino_ratio: null,
      volatility_pct: null,
      avg_holding_hours: d.avgHoldTime ?? null,
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
    const rawProfile = await this.requestWithCircuitBreaker<BitgetTraderDetailResponse>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderProfile(${traderKey})` },
    );
    const detail = warnValidate(BitgetTraderDetailResponseSchema, rawProfile, 'bitget/trader-detail') as unknown as BitgetTraderDetailResponse;

    const d = detail.data || {} as BitgetTraderDetailResponse['data'];

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.avatar || null,
      bio: d.introduction || null,
      copier_count: d.currentCopyCount ?? d.followerCount ?? null,
      aum_usd: d.aum ?? null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    if (seriesType !== 'equity_curve') {
      return {
        platform: this.platform,
        trader_key: traderKey,
        series_type: seriesType,
        data: [],
        as_of_ts: this.getDateBucket(),
      };
    }

    const entries = await this.requestWithCircuitBreaker<Array<{ time: number; value: number }>>(
      () => this.fetchPerformanceCurve(traderKey),
      { label: `fetchTimeseries(${traderKey}, ${seriesType})` },
    );

    const data = entries.map((e) => ({
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
  // Private
  // ============================================

  private async fetchLeaderboardPage(
    sortPeriod: number,
    page: number,
    pageSize: number,
  ): Promise<BitgetLeaderboardResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl}/trader/list`, {
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
          rule: 2,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Bitget API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTraderDetailApi(
    traderId: string,
  ): Promise<BitgetTraderDetailResponse> {
    const url = `${this.baseUrl}/trader/detail?traderId=${traderId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Bitget detail API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchPerformanceCurve(
    traderId: string,
  ): Promise<Array<{ time: number; value: number }>> {
    const url = `${this.baseUrl}/trader/profit-chart?traderId=${traderId}&timeRange=90`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) return [];

      const json = await response.json();
      const validated = warnValidate(BitgetPerformanceResponseSchema, json, 'bitget/performance');
      return validated.data?.list || [];
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
