/**
 * OKX copy trading connector (legacy interface).
 * Fetches public leaderboard data from OKX's copy trading API.
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
// OKX API types
// ============================================

interface OKXTraderEntry {
  uniqueName: string;
  nickName?: string;
  portrait?: string;
  roi?: number;
  pnl?: number;
  winRatio?: number;
  maxDrawdown?: number;
  copyTraderNum?: number;
  aum?: number;
}

interface OKXLeaderboardResponse {
  code: string;
  data: {
    ranks: OKXTraderEntry[];
    total?: number;
  };
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_PERIOD: Record<RankingWindow, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
};

// ============================================
// Connector Implementation
// ============================================

export class OKXConnector extends BaseConnectorLegacy implements LegacyPlatformConnector {
  readonly platform = 'okx' as const;
  private readonly baseUrl = 'https://www.okx.com/priapi/v5/ecotrade';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];

    const data = await this.requestWithCircuitBreaker<OKXLeaderboardResponse>(
      () => this.fetchLeaderboardApi(period),
      { label: `discoverLeaderboard(${window})` },
    );

    if (data.code !== '0' || !data.data?.ranks?.length) return traders;

    for (const entry of data.data.ranks) {
      if (!entry.uniqueName) continue;

      traders.push({
        platform: this.platform,
        trader_key: entry.uniqueName,
        display_name: entry.nickName || null,
        avatar_url: entry.portrait || null,
        profile_url: `https://www.okx.com/copy-trading/account/${entry.uniqueName}`,
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
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: OKXTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey, window),
      { label: `fetchTraderSnapshot(${traderKey}, ${window})` },
    );

    const d = detail.data || {} as OKXTraderEntry;

    const metrics: SnapshotMetricsLegacy = {
      roi_pct: d.roi != null ? (Math.abs(d.roi) < 10 ? d.roi * 100 : d.roi) : null,
      pnl_usd: d.pnl ?? null,
      win_rate_pct: d.winRatio != null ? (d.winRatio <= 1 ? d.winRatio * 100 : d.winRatio) : null,
      max_drawdown_pct: d.maxDrawdown != null ? Math.abs(d.maxDrawdown) : null,
      trades_count: null,
      copier_count: d.copyTraderNum ?? null,
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
    const detail = await this.requestWithCircuitBreaker<{ code: string; data: OKXTraderEntry }>(
      () => this.fetchTraderDetailApi(traderKey, '90d'),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const d = detail.data || {} as OKXTraderEntry;

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: d.nickName || null,
      avatar_url: d.portrait || null,
      bio: null,
      copier_count: d.copyTraderNum ?? null,
      aum_usd: d.aum ?? null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseriesLegacy, 'id' | 'created_at'>> {
    // OKX does not provide timeseries via public API
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

  private async fetchLeaderboardApi(period: string): Promise<OKXLeaderboardResponse> {
    const url = `${this.baseUrl}/public/rank-list?period=${period}&pageNo=1&pageSize=100&sortType=YIELD_RATE`;

    const response = await fetch(url, {
      headers: { 'User-Agent': this.getRandomUA() },
    });

    if (!response.ok) {
      throw new Error(`OKX leaderboard API returned ${response.status}`);
    }

    return response.json();
  }

  private async fetchTraderDetailApi(
    uniqueName: string,
    window: RankingWindow,
  ): Promise<{ code: string; data: OKXTraderEntry }> {
    const url = `${this.baseUrl}/public/trader-info?uniqueName=${uniqueName}&period=${WINDOW_TO_PERIOD[window]}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': this.getRandomUA() },
    });

    if (!response.ok) {
      throw new Error(`OKX trader detail API returned ${response.status}`);
    }

    const json: { code: string; data: OKXTraderEntry } = await response.json();
    if (json.code !== '0' || !json.data) {
      throw new Error(`OKX trader detail API returned no data for ${uniqueName}`);
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
