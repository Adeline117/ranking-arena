/**
 * Hyperliquid connector.
 * Fetches trader data from Hyperliquid's public info API.
 *
 * Data source: Public REST API (no auth required).
 * API: https://api.hyperliquid.xyz/info
 * Rate limits: Generous, 30 req/min with 1-3s jitter.
 *
 * Notes:
 * - Hyperliquid uses wallet addresses as trader keys.
 * - No copier/follower concept (on-chain DEX).
 * - Win rate must be derived from position history.
 */

import { BaseConnector, ConnectorError } from './base';
import type {
  RankingWindow,
  TraderIdentity,
  TraderSnapshot,
  TraderProfileEnriched,
  TraderTimeseries,
  TimeseriesType,
  SnapshotMetrics,
  TimeseriesPoint,
} from '@/lib/types/leaderboard';

// ============================================
// Hyperliquid API types
// ============================================

interface HyperliquidLeaderEntry {
  ethAddress: string;
  displayName?: string;
  accountValue: number;
  pnl: number;
  roi: number;
  vlm: number;
  maxDrawdown?: number;
  nTrades?: number;
  winRate?: number;
}

interface HyperliquidUserState {
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      unrealizedPnl: string;
      returnOnEquity: string;
    };
  }>;
  marginSummary: {
    accountValue: string;
    totalRawUsd: string;
  };
}

interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  closedPnl: string;
}

// ============================================
// Window mapping
// ============================================

const WINDOW_TO_MS: Record<RankingWindow, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

const WINDOW_TO_PERIOD: Record<RankingWindow, string> = {
  '7d': 'week',
  '30d': 'month',
  '90d': 'allTime',
};

// ============================================
// Connector
// ============================================

export class HyperliquidConnector extends BaseConnector {
  readonly platform = 'hyperliquid' as const;
  private readonly apiUrl = 'https://api.hyperliquid.xyz/info';

  constructor() {
    super();
    this.init();
  }

  async discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]> {
    const period = WINDOW_TO_PERIOD[window];
    const traders: TraderIdentity[] = [];

    const data = await this.request<HyperliquidLeaderEntry[]>(
      () => this.fetchLeaderboard(period),
      { label: `discoverLeaderboard(${window})` },
    );

    for (const entry of data.slice(0, 100)) {
      if (!entry.ethAddress) continue;

      traders.push({
        platform: this.platform,
        trader_key: entry.ethAddress.toLowerCase(),
        display_name: entry.displayName || this.truncateAddress(entry.ethAddress),
        avatar_url: null, // On-chain: no avatar
        profile_url: `https://app.hyperliquid.xyz/explorer/address/${entry.ethAddress}`,
        discovered_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
      });
    }

    return traders;
  }

  async fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshot, 'id' | 'created_at'>> {
    // Fetch user state and fills in parallel
    const [userState, pnlData] = await Promise.all([
      this.request<HyperliquidUserState>(
        () => this.fetchUserState(traderKey),
        { label: `fetchUserState(${traderKey})` },
      ),
      this.request<{ pnl: number; roi: number; nTrades: number; winRate: number | null }>(
        () => this.fetchUserPnl(traderKey, window),
        { label: `fetchUserPnl(${traderKey}, ${window})` },
      ),
    ]);

    const metrics: SnapshotMetrics = {
      roi_pct: pnlData.roi != null ? pnlData.roi * 100 : null,
      pnl_usd: pnlData.pnl ?? null,
      win_rate_pct: pnlData.winRate != null ? pnlData.winRate * 100 : null,
      max_drawdown_pct: null, // Would require historical equity curve analysis
      trades_count: pnlData.nTrades ?? null,
      copier_count: null, // No copy trading on Hyperliquid
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
    const userState = await this.request<HyperliquidUserState>(
      () => this.fetchUserState(traderKey),
      { label: `fetchTraderProfile(${traderKey})` },
    );

    const accountValue = parseFloat(userState.marginSummary?.accountValue || '0');

    return {
      platform: this.platform,
      trader_key: traderKey,
      display_name: this.truncateAddress(traderKey),
      avatar_url: null,
      bio: null,
      copier_count: null,
      aum_usd: accountValue > 0 ? accountValue : null,
      active_since: null,
      platform_tier: null,
    };
  }

  async fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseries, 'id' | 'created_at'>> {
    if (seriesType !== 'daily_pnl') {
      return {
        platform: this.platform,
        trader_key: traderKey,
        series_type: seriesType,
        data: [],
        as_of_ts: this.getDateBucket(),
      };
    }

    // Fetch recent fills and aggregate daily PnL
    const fills = await this.request<HyperliquidFill[]>(
      () => this.fetchUserFills(traderKey),
      { label: `fetchTimeseries(${traderKey}, daily_pnl)` },
    );

    // Aggregate by day
    const dailyPnl = new Map<string, number>();
    for (const fill of fills) {
      const day = new Date(fill.time).toISOString().split('T')[0];
      const pnl = parseFloat(fill.closedPnl || '0');
      dailyPnl.set(day, (dailyPnl.get(day) || 0) + pnl);
    }

    const data: TimeseriesPoint[] = Array.from(dailyPnl.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ts, value]) => ({ ts, value }));

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

  private async fetchLeaderboard(period: string): Promise<HyperliquidLeaderEntry[]> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'leaderboard',
        timeWindow: period,
      }),
    });

    if (!response.ok) {
      throw new ConnectorError(`Hyperliquid API returned ${response.status}`, this.platform, response.status >= 500);
    }

    const json = await response.json();
    return json.leaderboardRows || json || [];
  }

  private async fetchUserState(address: string): Promise<HyperliquidUserState> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'clearinghouseState',
        user: address,
      }),
    });

    if (!response.ok) {
      throw new ConnectorError(`Hyperliquid user state API returned ${response.status}`, this.platform);
    }

    return response.json();
  }

  private async fetchUserPnl(
    address: string,
    window: RankingWindow,
  ): Promise<{ pnl: number; roi: number; nTrades: number; winRate: number | null }> {
    // Fetch fills for the window period
    const startTime = Date.now() - WINDOW_TO_MS[window];

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFills',
        user: address,
        startTime,
      }),
    });

    if (!response.ok) {
      return { pnl: 0, roi: 0, nTrades: 0, winRate: null };
    }

    const fills: HyperliquidFill[] = await response.json();

    let totalPnl = 0;
    let wins = 0;
    let losses = 0;

    for (const fill of fills) {
      const pnl = parseFloat(fill.closedPnl || '0');
      if (pnl !== 0) {
        totalPnl += pnl;
        if (pnl > 0) wins++;
        else losses++;
      }
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? wins / totalTrades : null;

    return {
      pnl: totalPnl,
      roi: 0, // Would need initial equity to calculate
      nTrades: fills.length,
      winRate,
    };
  }

  private async fetchUserFills(address: string): Promise<HyperliquidFill[]> {
    const startTime = Date.now() - 90 * 24 * 60 * 60 * 1000; // Last 90 days

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFills',
        user: address,
        startTime,
      }),
    });

    if (!response.ok) return [];
    return response.json();
  }

  private truncateAddress(address: string): string {
    if (address.length <= 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
}
