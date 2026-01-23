/**
 * Hyperliquid Perpetual DEX Leaderboard Connector
 *
 * Source: https://app.hyperliquid.xyz/leaderboard
 * API: Public info API (L1 chain data)
 * Windows: 7D, 30D derived from account state; 90D available
 * ROI Sort: Client-side (API returns PnL, sorted by ROI locally)
 * Data: On-chain (Hyperliquid L1), fully public
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

const API_BASE = 'https://api.hyperliquid.xyz';
const APP_BASE = 'https://app.hyperliquid.xyz';

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'week',
  '30d': 'month',
  '90d': 'allTime', // Hyperliquid may not have 90d specifically
};

export class HyperliquidConnector extends BaseConnector {
  platform: Platform = 'hyperliquid';
  market_type: MarketType = 'perp';

  protected rate_limit = { rpm: 30, concurrent: 2, delay_ms: 2000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      // Hyperliquid uses POST to /info endpoint with action type
      const response = await this.postJSON<HyperliquidLeaderboardResponse>(
        `${API_BASE}/info`,
        {
          type: 'leaderboard',
          timeWindow: WINDOW_MAP[window],
        }
      );

      if (!response?.leaderboardRows) {
        // Try clearinghouse state approach
        return this.tryClearinghouseApproach(window, limit);
      }

      const entries: LeaderboardEntry[] = response.leaderboardRows
        .map((item, idx) => {
          const pnl = Number(item.accountValue) - Number(item.windowPerformances?.[WINDOW_MAP[window]]?.startingValue || item.accountValue);
          const startingValue = Number(item.windowPerformances?.[WINDOW_MAP[window]]?.startingValue || 1);
          const roi = startingValue > 0 ? (pnl / startingValue) * 100 : this.parseNumber(item.roi);

          return {
            trader_key: item.ethAddress.toLowerCase(),
            display_name: item.displayName || `${item.ethAddress.slice(0, 6)}...${item.ethAddress.slice(-4)}`,
            avatar_url: null,
            profile_url: `${APP_BASE}/@${item.ethAddress}`,
            rank: idx + 1,
            metrics: {
              roi_pct: roi ?? this.parseNumber(item.pnl),
              pnl_usd: pnl || this.parseNumber(item.pnl),
              win_rate: null,
              max_drawdown: null,
              trades_count: null,
              followers: null,
              copiers: null,
              sharpe_ratio: null,
              aum: this.parseNumber(item.accountValue),
            },
            raw: item as unknown as Record<string, unknown>,
          };
        })
        .sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: `${API_BASE}/info`,
        platform_sorting: 'roi_desc',
        platform_window: window,
        reason: window === '90d' ? 'Using allTime as proxy for 90D (platform does not provide exact 90D)' : undefined,
      }, window === '90d' ? { window_not_supported: true, reason: 'Using allTime as proxy' } : {});
    } catch (error) {
      return this.failure(`Hyperliquid leaderboard failed: ${(error as Error).message}`);
    }
  }

  private async tryClearinghouseApproach(window: Window, limit: number): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      // Alternative: use the clearinghouse state for top traders
      const response = await this.postJSON<{ leaderboard: Record<string, unknown>[] }>(
        `${API_BASE}/info`,
        { type: 'frontendLeaderboard', timeWindow: WINDOW_MAP[window] }
      );

      if (!response?.leaderboard) return this.success([]);

      const entries: LeaderboardEntry[] = response.leaderboard.map((item, idx) => ({
        trader_key: String(item.user || item.address).toLowerCase(),
        display_name: (item.displayName as string) || null,
        avatar_url: null,
        profile_url: `${APP_BASE}/@${item.user || item.address}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));
      return this.success(entries.slice(0, limit), { source_url: `${API_BASE}/info`, platform_sorting: 'roi_desc' });
    } catch {
      return this.success([]);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const response = await this.postJSON<{ accountValue: string; marginSummary: Record<string, unknown> }>(
        `${API_BASE}/info`,
        { type: 'clearinghouseState', user: trader_key }
      );

      return this.success<CanonicalProfile>({
        platform: 'hyperliquid',
        market_type: 'perp',
        trader_key,
        display_name: `${trader_key.slice(0, 6)}...${trader_key.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['on-chain', 'hyperliquid'],
        profile_url: `${APP_BASE}/@${trader_key}`,
        followers: null,
        copiers: null,
        aum: this.parseNumber(response?.marginSummary?.accountValue ?? response?.accountValue) as number | null,
        provenance: this.buildProvenance(`${API_BASE}/info`),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const response = await this.postJSON<{ clearinghouseState: Record<string, unknown>; assetPositions: Record<string, unknown>[] }>(
        `${API_BASE}/info`,
        { type: 'clearinghouseState', user: trader_key }
      );

      if (!response) return this.failure('No clearinghouse state');

      const accountValue = this.parseNumber(
        (response.clearinghouseState as Record<string, unknown>)?.accountValue ?? response.assetPositions
      );

      const metrics: SnapshotMetrics = {
        roi_pct: null, // Would need historical data to calculate
        pnl_usd: null,
        win_rate: null,
        max_drawdown: null,
        trades_count: null,
        followers: null,
        copiers: null,
        sharpe_ratio: null,
        aum: accountValue,
      };

      return this.success<CanonicalSnapshot>({
        platform: 'hyperliquid',
        market_type: 'perp',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics,
        quality_flags: {
          missing_roi: true,
          missing_pnl: true,
          missing_win_rate: true,
          missing_drawdown: true,
          reason: 'Individual snapshot requires leaderboard context for ROI calculation',
        },
        provenance: this.buildProvenance(`${API_BASE}/info`),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'Hyperliquid timeseries not available via public API' });
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    const pnl = this.parseNumber(raw.pnl ?? raw.totalPnl ?? raw.profit);
    const accountValue = this.parseNumber(raw.accountValue ?? raw.equity);
    const startingValue = this.parseNumber(raw.startingValue);
    let roi = this.parseNumber(raw.roi ?? raw.pnlPercent);

    if (!roi && pnl && startingValue && startingValue > 0) {
      roi = (pnl / startingValue) * 100;
    }

    return {
      roi_pct: roi,
      pnl_usd: pnl,
      win_rate: null,
      max_drawdown: null,
      trades_count: null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: accountValue,
    };
  }
}

interface HyperliquidLeaderboardResponse {
  leaderboardRows: HyperliquidLeaderEntry[];
}

interface HyperliquidLeaderEntry {
  ethAddress: string;
  displayName: string;
  accountValue: string;
  pnl: string;
  roi: string;
  windowPerformances: Record<string, { startingValue: string }>;
}
