/**
 * KuCoin copy trading connector (legacy interface).
 * Fetches public leaderboard data from KuCoin's copy trading API.
 *
 * Data source: Public copy trading leaderboard.
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
// KuCoin API types
// ============================================

interface KuCoinTraderEntry {
  leaderId: string;
  nickName?: string;
  avatar?: string;
  roi?: number;
  pnl?: number;
  totalPnl?: number;
  winRate?: number;
  maxDrawdown?: number;
  followerCount?: number;
  tradeCount?: number;
  aum?: number;
}

interface KuCoinLeaderboardResponse {
  code: string;
  data: {
    items: KuCoinTraderEntry[];
    totalNum?: number;
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
// Connector Implementation
// ============================================

export class KuCoinConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'kucoin' as const;
  private readonly baseUrl = 'https://www.kucoin.com/_api/copy-trade/leader';

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
      const data = await this.requestWithCircuitBreaker<KuCoinLeaderboardResponse>(
        () => this.fetchLeaderboardPage(period, page, pageSize),
        { label: `discoverLeaderboard(${window}, page=${page})` },
      );

      if (data.code !== '200000' || !data.data?.items?.length) break;

      for (const entry of data.data.items) {
        if (!entry.leaderId) continue;

        traders.push({
          platform: this.platform,
          trader_key: entry.leaderId,
          display_name: entry.nickName || null,
          avatar_url: entry.avatar || null,
          profile_url: `https://www.kucoin.com/copy-trade/trader/${entry.leaderId}`,
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
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: KuCoinTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey, window),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const d = detail.data || {} as KuCoinTraderEntry;
    const roi = d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: roi,
      pnl_usd: d.totalPnl ?? d.pnl ?? null,
      win_rate_pct: d.winRate != null ? (d.winRate <= 1 ? d.winRate * 100 : d.winRate) : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      trades_count: d.tradeCount ?? null,
      copier_count: d.followerCount ?? null,
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
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: KuCoinTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey, '90d'),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const d = detail.data || {} as KuCoinTraderEntry;

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.avatar || null,
      bio: null,
      copier_count: d.followerCount ?? null,
      aum_usd: d.aum ?? null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    // KuCoin does not provide timeseries via public API
    return {
      platform: this.platform,
      trader_key: traderKey,
      series_type: seriesType,
      data: [],
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
  ): Promise<KuCoinLeaderboardResponse> {
    const url = `${this.baseUrl}/rank-list?period=${period}&pageNo=${page}&pageSize=${pageSize}&sortField=ROI`;

    const response = await fetch(url, {
      headers: { 'User-Agent': this.getRandomUA() },
    });

    if (!response.ok) {
      throw new Error(`KuCoin leaderboard API returned ${response.status}`);
    }

    return response.json();
  }

  private async fetchTraderDetailApi(
    leaderId: string,
    window: RankingWindow,
  ): Promise<{ code: string; data: KuCoinTraderEntry }> {
    const url = `${this.baseUrl}/detail?leaderId=${leaderId}&period=${WINDOW_TO_PERIOD[window]}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': this.getRandomUA() },
    });

    if (!response.ok) {
      throw new Error(`KuCoin trader detail API returned ${response.status}`);
    }

    const json: { code: string; data: KuCoinTraderEntry } = await response.json();
    if (json.code !== '200000' || !json.data) {
      throw new Error(`KuCoin trader detail API returned no data for ${leaderId}`);
    }

    return json;
  }

  private getRandomUA(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}
