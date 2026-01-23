/**
 * dYdX Perpetual DEX Leaderboard Connector
 *
 * Source: https://dydx.exchange/leaderboard
 * API: Public indexer API (v4 chain)
 * Windows: 7D, 30D available; 90D from historical
 * ROI Sort: Client-side (API returns PnL, ROI calculated)
 * Data: On-chain (dYdX v4 chain), fully public
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

// dYdX v4 indexer
const INDEXER_BASE = 'https://indexer.dydx.trade';
const DYDX_APP = 'https://dydx.exchange';

const WINDOW_MAP: Record<Window, string> = {
  '7d': 'WEEKLY',
  '30d': 'MONTHLY',
  '90d': 'QUARTERLY',
};

export class DydxConnector extends BaseConnector {
  platform: Platform = 'dydx';
  market_type: MarketType = 'perp';

  protected rate_limit = { rpm: 30, concurrent: 2, delay_ms: 2000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      // dYdX v4 leaderboard endpoint
      const url = `${INDEXER_BASE}/v4/leaderboard?period=${WINDOW_MAP[window]}&limit=${Math.min(limit, 200)}`;

      const response = await this.fetchJSON<DydxLeaderboardResponse>(url);

      if (!response?.leaderboard) {
        // Try alternative endpoint
        return this.tryAlternativeEndpoint(window, limit);
      }

      const entries: LeaderboardEntry[] = response.leaderboard
        .map((item, idx) => ({
          trader_key: item.address || item.subaccountId,
          display_name: item.username || `${(item.address || '').slice(0, 8)}...`,
          avatar_url: null,
          profile_url: `${DYDX_APP}/portfolio/${item.address}`,
          rank: idx + 1,
          metrics: this.normalize(item as unknown as Record<string, unknown>, {}),
          raw: item as unknown as Record<string, unknown>,
        }))
        .sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
        platform_window: window,
        reason: 'dYdX sorted client-side by ROI',
      });
    } catch (error) {
      return this.failure(`dYdX leaderboard failed: ${(error as Error).message}`);
    }
  }

  private async tryAlternativeEndpoint(window: Window, limit: number): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const url = `${INDEXER_BASE}/v4/rankings?timeframe=${WINDOW_MAP[window]}&limit=${limit}`;
      const response = await this.fetchJSON<{ rankings: Record<string, unknown>[] }>(url);

      if (!response?.rankings) return this.success([]);

      const entries: LeaderboardEntry[] = response.rankings.map((item, idx) => ({
        trader_key: String(item.address || item.subaccountId),
        display_name: (item.username as string) || null,
        avatar_url: null,
        profile_url: `${DYDX_APP}/portfolio/${item.address}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));
      return this.success(entries.slice(0, limit), { source_url: url, platform_sorting: 'roi_desc' });
    } catch {
      return this.success([]);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    try {
      const url = `${INDEXER_BASE}/v4/addresses/${trader_key}`;
      const response = await this.fetchJSON<{ subaccounts: Record<string, unknown>[] }>(url);

      return this.success<CanonicalProfile>({
        platform: 'dydx',
        market_type: 'perp',
        trader_key,
        display_name: `${trader_key.slice(0, 8)}...${trader_key.slice(-4)}`,
        avatar_url: null,
        bio: null,
        tags: ['on-chain', 'dydx-v4'],
        profile_url: `${DYDX_APP}/portfolio/${trader_key}`,
        followers: null,
        copiers: null,
        aum: response?.subaccounts?.[0]
          ? this.parseNumber((response.subaccounts[0] as Record<string, unknown>).equity) as number | null
          : null,
        provenance: this.buildProvenance(url),
      });
    } catch (error) {
      return this.failure(`Profile fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const url = `${INDEXER_BASE}/v4/addresses/${trader_key}/subaccountNumber/0/historicalPnl?period=${WINDOW_MAP[window]}`;
      const response = await this.fetchJSON<{ historicalPnl: DydxPnlEntry[] }>(url);

      if (!response?.historicalPnl?.length) return this.failure('No PnL data');

      const pnlData = response.historicalPnl;
      const totalPnl = pnlData.reduce((sum, entry) => sum + Number(entry.totalPnl || 0), 0);
      const equity = Number(pnlData[pnlData.length - 1]?.equity || 0);
      const roi = equity > 0 ? (totalPnl / equity) * 100 : null;

      const metrics: SnapshotMetrics = {
        roi_pct: roi,
        pnl_usd: totalPnl,
        win_rate: null,
        max_drawdown: null,
        trades_count: null,
        followers: null,
        copiers: null,
        sharpe_ratio: null,
        aum: equity || null,
      };

      return this.success<CanonicalSnapshot>({
        platform: 'dydx',
        market_type: 'perp',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics,
        quality_flags: { missing_win_rate: true, missing_drawdown: true, missing_trades_count: true },
        provenance: this.buildProvenance(url, { platform_window: window }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    try {
      const url = `${INDEXER_BASE}/v4/addresses/${trader_key}/subaccountNumber/0/historicalPnl?period=MONTHLY`;
      const response = await this.fetchJSON<{ historicalPnl: DydxPnlEntry[] }>(url);

      if (!response?.historicalPnl) return this.success([]);

      return this.success<CanonicalTimeseries[]>([{
        platform: 'dydx',
        market_type: 'perp',
        trader_key,
        series_type: 'equity_curve',
        as_of_ts: new Date().toISOString(),
        data: response.historicalPnl.map(entry => ({
          ts: entry.createdAt,
          value: Number(entry.equity || 0),
        })),
        provenance: this.buildProvenance(url),
      }]);
    } catch (error) {
      return this.success([], { reason: `Timeseries failed: ${(error as Error).message}` });
    }
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    const pnl = this.parseNumber(raw.totalPnl ?? raw.pnl ?? raw.realizedPnl) ?? 0;
    const equity = this.parseNumber(raw.equity ?? raw.totalEquity) ?? 0;
    const roi = equity > 0 ? (pnl / equity) * 100 : this.parseNumber(raw.pnlPercent ?? raw.roi);

    return {
      roi_pct: roi,
      pnl_usd: pnl,
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: this.parseNumber(raw.maxDrawdown),
      trades_count: this.parseNumber(raw.totalTrades ?? raw.numTrades) as number | null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: equity || null,
    };
  }
}

interface DydxLeaderboardResponse {
  leaderboard: DydxLeaderEntry[];
}

interface DydxLeaderEntry {
  address: string;
  subaccountId: string;
  username: string;
  totalPnl: string;
  equity: string;
  pnlPercent: string;
}

interface DydxPnlEntry {
  createdAt: string;
  totalPnl: string;
  equity: string;
}
