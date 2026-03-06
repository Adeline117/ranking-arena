/**
 * CoinEx copy trading connector.
 * Fetches public leaderboard data from CoinEx's copy trading API.
 *
 * Data source: Public copy trading leaderboard.
 * Rate limits: 15 req/min with 3-6s jitter.
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
// CoinEx API types
// ============================================

interface CoinExTraderEntry {
  trader_id: string;
  nick_name?: string;
  avatar?: string;
  roi?: number;
  pnl?: number;
  total_pnl?: number;
  win_rate?: number;
  max_drawdown?: number;
  follower_count?: number;
  trade_count?: number;
}

interface CoinExLeaderboardResponse {
  code: number;
  data: {
    data: CoinExTraderEntry[];
    total?: number;
  };
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_PERIOD: Record<RankingWindow, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
};

// ============================================
// Connector
// ============================================

export class CoinExConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'coinex' as const;
  private readonly baseUrl = 'https://www.coinex.com/res/copy-trade';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];

    for (let page = 1; page <= 5; page++) {
      const data = await this.requestWithCircuitBreaker<CoinExLeaderboardResponse>(
        () => this.fetchLeaderboardPage(period, page, 20),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );

      if (data.code !== 0 || !data.data?.data?.length) break;

      for (const entry of data.data.data) {
        if (!entry.trader_id) continue;

        traders.push({
          platform: this.platform,
          trader_key: entry.trader_id,
          display_name: entry.nick_name || null,
          avatar_url: entry.avatar || null,
          profile_url: `https://www.coinex.com/en/copy-trading/futures/trader/${entry.trader_id}`,
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
    const detail = await this.requestWithCircuitBreaker<{ code: number; data: CoinExTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const d = detail.data || {};
    const roi = d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: roi,
      pnl_usd: d.total_pnl ?? d.pnl ?? null,
      win_rate_pct: d.win_rate != null ? (d.win_rate <= 1 ? d.win_rate * 100 : d.win_rate) : null,
      max_drawdown_pct: d.max_drawdown != null ? Math.abs(d.max_drawdown) : null,
      trades_count: d.trade_count ?? null,
      copier_count: d.follower_count ?? null,
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
    const detail = await this.requestWithCircuitBreaker<{ code: number; data: CoinExTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const d = detail.data || {};

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nick_name || null,
      avatar_url: d.avatar || null,
      bio: null,
      copier_count: d.follower_count ?? null,
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
    period: string,
    page: number,
    pageSize: number,
  ): Promise<CoinExLeaderboardResponse> {
    const url = `${this.baseUrl}/rank?period=${period}&page=${page}&limit=${pageSize}&sort=roi`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`CoinEx API returned ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTraderDetailApi(traderId: string): Promise<{ code: number; data: CoinExTraderEntry }> {
    const url = `${this.baseUrl}/trader/detail?trader_id=${traderId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': this.getRandomUA() },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`CoinEx detail API returned ${response.status}`);
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
