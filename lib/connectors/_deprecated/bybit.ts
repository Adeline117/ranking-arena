/**
 * Bybit copy trading connector.
 * Fetches public leaderboard data from Bybit's copy trading API.
 *
 * Data source: Public copy trading leaderboard (no auth required).
 * Rate limits: 30 req/min with 2-5s jitter.
 */

import { BaseConnectorLegacy } from '../base';
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
  BybitLeaderboardResponseSchema,
  BybitTraderDetailResponseSchema,
  BybitPerformanceResponseSchema,
  warnValidate,
} from '../schemas';

// ============================================
// Bybit API types
// ============================================

interface BybitLeaderEntry {
  leaderId: string;
  nickName?: string;
  leaderName?: string;
  avatar?: string;
  avatarUrl?: string;
  roi?: number;
  roiRate?: number;
  pnl?: number;
  totalPnl?: number;
  winRate?: number;
  mdd?: number;
  maxDrawdown?: number;
  followerCount?: number;
  copierNum?: number;
}

interface BybitLeaderboardResponse {
  retCode: number;
  result: {
    list: BybitLeaderEntry[];
    total?: number;
  };
}

interface BybitTraderDetailResponse {
  retCode: number;
  result: {
    leaderId: string;
    nickName?: string;
    avatar?: string;
    introduction?: string;
    followerCount?: number;
    copierNum?: number;
    aum?: number;
    createTime?: number;
    totalPnl?: number;
    roi?: number;
    winRate?: number;
    maxDrawdown?: number;
    tradeCount?: number;
    avgHoldTime?: number;
    sharpeRatio?: number;
  };
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_PERIOD: Record<RankingWindow, string> = {
  '7d': '7',
  '30d': '30',
  '90d': '90',
};

// ============================================
// Connector
// ============================================

export class BybitConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'bybit' as const;
  private readonly baseUrl = 'https://api2.bybit.com/fapi/beehive/public/v1';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];
    const pageSize = 20;
    const maxPages = 5;

    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.requestWithCircuitBreaker<BybitLeaderboardResponse>(
        () => this.fetchLeaderboardPage(period, page, pageSize),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );
      const data = warnValidate(BybitLeaderboardResponseSchema, raw, 'bybit/leaderboard') as unknown as BybitLeaderboardResponse;

      if (data.retCode !== 0 || !data.result?.list?.length) break;

      for (const entry of data.result.list) {
        const id = entry.leaderId;
        if (!id) continue;

        traders.push({
          platform: this.platform,
          trader_key: id,
          display_name: entry.nickName || entry.leaderName || null,
          avatar_url: entry.avatar || entry.avatarUrl || null,
          profile_url: `https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=${id}`,
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
    const raw = await this.requestWithCircuitBreaker<BybitTraderDetailResponse>(
      () => this.fetchTraderDetailApi(traderKey, window),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );
    const detail = warnValidate(BybitTraderDetailResponseSchema, raw, 'bybit/trader-detail') as unknown as BybitTraderDetailResponse;

    const d = detail.result;
    const roi = d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: roi,
      pnl_usd: d.totalPnl ?? null,
      win_rate_pct: d.winRate != null ? (d.winRate <= 1 ? d.winRate * 100 : d.winRate) : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      trades_count: d.tradeCount ?? null,
      copier_count: d.copierNum ?? d.followerCount ?? null,
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
    const rawProfile = await this.requestWithCircuitBreaker<BybitTraderDetailResponse>(
      () => this.fetchTraderDetailApi(traderKey, '90d'),
      { label: `fetchTraderProfile(${traderKey})` },
    );
    const detail = warnValidate(BybitTraderDetailResponseSchema, rawProfile, 'bybit/trader-detail') as unknown as BybitTraderDetailResponse;

    const d = detail.result;

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.avatar || null,
      bio: d.introduction || null,
      copier_count: d.copierNum ?? d.followerCount ?? null,
      aum_usd: d.aum ?? null,
      active_since: d.createTime ? new Date(d.createTime).toISOString().split('T')[0] : null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    // Bybit performance curve: ROI over time
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
  // Private
  // ============================================

  private async fetchLeaderboardPage(
    period: string,
    page: number,
    pageSize: number,
  ): Promise<BybitLeaderboardResponse> {
    const url = `${this.baseUrl}/leader-board?timeRange=${period}&page=${page}&pageSize=${pageSize}&sortField=ROI&sortType=DESC`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Bybit API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTraderDetailApi(
    leaderId: string,
    window: RankingWindow,
  ): Promise<BybitTraderDetailResponse> {
    const url = `${this.baseUrl}/leader/${leaderId}?timeRange=${WINDOW_TO_PERIOD[window]}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Bybit detail API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchPerformanceCurve(
    leaderId: string,
  ): Promise<Array<{ time: number; value: number }>> {
    const url = `${this.baseUrl}/leader/${leaderId}/performance?dataType=ROI&timeRange=90`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) return [];

      const json = await response.json();
      const validated = warnValidate(BybitPerformanceResponseSchema, json, 'bybit/performance');
      return validated.result?.list || [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private getRandomUA(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}
