/**
 * GMX DEX Leaderboard Connector
 *
 * Source: https://app.gmx.io/#/leaderboard
 * API: Public subgraph endpoints (The Graph)
 * Windows: 7D, 30D available; 90D derived from on-chain data
 * ROI Sort: Client-side (subgraph returns all data, sorted locally)
 * Data: On-chain, fully public, no auth required
 */

import { BaseConnector } from '../base/connector';
import type {
  Platform, MarketType, Window,
  ConnectorResult, LeaderboardEntry,
  CanonicalProfile, CanonicalSnapshot, CanonicalTimeseries,
  SnapshotMetrics,
} from '../base/types';

// GMX V2 Arbitrum subgraph
const SUBGRAPH_URL = 'https://subgraph.satsuma-prod.com/3b2ced13c8d9/gmx/synthetics-arbitrum-stats/api';
const GMX_APP = 'https://app.gmx.io';

export class GmxConnector extends BaseConnector {
  platform: Platform = 'gmx';
  market_type: MarketType = 'perp';

  protected rate_limit = { rpm: 30, concurrent: 3, delay_ms: 2000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodSeconds = window === '7d' ? 604800 : window === '30d' ? 2592000 : 7776000;
      const since = Math.floor(Date.now() / 1000) - periodSeconds;

      // GMX leaderboard via stats subgraph
      const query = `{
        periodAccountStats(
          first: ${Math.min(limit, 1000)},
          orderBy: totalPnlAfterFees,
          orderDirection: desc,
          where: { period: "total", totalTrades_gt: 0, timestamp_gt: ${since} }
        ) {
          id
          account
          totalPnlAfterFees
          totalCollateral
          totalTrades
          winCount
          lossCount
          maxCollateral
          timestamp
        }
      }`;

      const response = await this.postJSON<{ data: { periodAccountStats: GmxAccountStat[] } }>(
        SUBGRAPH_URL,
        { query },
      );

      if (!response?.data?.periodAccountStats) {
        // Fallback: try the leaderboard API
        return this.tryLeaderboardApi(window, limit);
      }

      const entries: LeaderboardEntry[] = response.data.periodAccountStats
        .map((item, idx) => {
          const collateral = Number(item.totalCollateral) / 1e30;
          const pnl = Number(item.totalPnlAfterFees) / 1e30;
          const roi = collateral > 0 ? (pnl / collateral) * 100 : 0;

          return {
            trader_key: item.account.toLowerCase(),
            display_name: `${item.account.slice(0, 6)}...${item.account.slice(-4)}`,
            avatar_url: null,
            profile_url: `${GMX_APP}/#/actions/${item.account}`,
            rank: idx + 1,
            metrics: {
              roi_pct: roi,
              pnl_usd: pnl,
              win_rate: item.winCount + item.lossCount > 0
                ? (item.winCount / (item.winCount + item.lossCount)) * 100
                : null,
              max_drawdown: null,
              trades_count: item.totalTrades,
              followers: null,
              copiers: null,
              sharpe_ratio: null,
              aum: collateral,
            },
            raw: item as unknown as Record<string, unknown>,
          };
        })
        // Sort by ROI descending
        .sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: SUBGRAPH_URL,
        platform_sorting: 'roi_desc',
        platform_window: window,
        reason: 'Sorted client-side by ROI from on-chain PnL/collateral',
      });
    } catch (error) {
      return this.failure(`GMX leaderboard failed: ${(error as Error).message}`);
    }
  }

  private async tryLeaderboardApi(window: Window, limit: number): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      const periodMap: Record<Window, string> = { '7d': '7d', '30d': '30d', '90d': '90d' };
      const url = `https://arbitrum-api.gmxinfra.io/leaderboard/positions?period=${periodMap[window]}&limit=${limit}`;
      const response = await this.fetchJSON<{ data: Record<string, unknown>[] }>(url);

      if (!response?.data) return this.success([]);

      const entries: LeaderboardEntry[] = response.data.map((item, idx) => ({
        trader_key: String(item.account || item.address).toLowerCase(),
        display_name: null,
        avatar_url: null,
        profile_url: `${GMX_APP}/#/actions/${item.account || item.address}`,
        rank: idx + 1,
        metrics: this.normalize(item, {}),
        raw: item,
      }));

      entries.sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: url,
        platform_sorting: 'roi_desc',
      });
    } catch {
      return this.success([]);
    }
  }

  async fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>> {
    return this.success<CanonicalProfile>({
      platform: 'gmx',
      market_type: 'perp',
      trader_key,
      display_name: `${trader_key.slice(0, 6)}...${trader_key.slice(-4)}`,
      avatar_url: null,
      bio: null,
      tags: ['on-chain', 'arbitrum'],
      profile_url: `${GMX_APP}/#/actions/${trader_key}`,
      followers: null,
      copiers: null,
      aum: null,
      provenance: this.buildProvenance(`${GMX_APP}/#/actions/${trader_key}`),
    });
  }

  async fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>> {
    try {
      const periodSeconds = window === '7d' ? 604800 : window === '30d' ? 2592000 : 7776000;
      const since = Math.floor(Date.now() / 1000) - periodSeconds;

      const query = `{
        periodAccountStats(
          where: { account: "${trader_key.toLowerCase()}", period: "total", timestamp_gt: ${since} }
          first: 1
        ) {
          totalPnlAfterFees
          totalCollateral
          totalTrades
          winCount
          lossCount
          maxCollateral
        }
      }`;

      const response = await this.postJSON<{ data: { periodAccountStats: GmxAccountStat[] } }>(
        SUBGRAPH_URL,
        { query },
      );

      const stats = response?.data?.periodAccountStats?.[0];
      if (!stats) return this.failure('No on-chain stats found for this period');

      const collateral = Number(stats.totalCollateral) / 1e30;
      const pnl = Number(stats.totalPnlAfterFees) / 1e30;
      const roi = collateral > 0 ? (pnl / collateral) * 100 : 0;

      const metrics: SnapshotMetrics = {
        roi_pct: roi,
        pnl_usd: pnl,
        win_rate: stats.winCount + stats.lossCount > 0
          ? (stats.winCount / (stats.winCount + stats.lossCount)) * 100
          : null,
        max_drawdown: null,
        trades_count: stats.totalTrades,
        followers: null,
        copiers: null,
        sharpe_ratio: null,
        aum: collateral,
      };

      return this.success<CanonicalSnapshot>({
        platform: 'gmx',
        market_type: 'perp',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics,
        quality_flags: { missing_drawdown: true, missing_sharpe: true },
        provenance: this.buildProvenance(SUBGRAPH_URL, { platform_sorting: 'roi_desc', platform_window: window }),
      });
    } catch (error) {
      return this.failure(`Snapshot fetch failed: ${(error as Error).message}`);
    }
  }

  async fetchTimeseries(_trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>> {
    return this.success([], { reason: 'GMX timeseries requires trade-by-trade reconstruction' });
  }

  normalize(raw: Record<string, unknown>, _field_map?: Record<string, string>): Partial<SnapshotMetrics> {
    const collateral = this.parseNumber(raw.totalCollateral ?? raw.collateral) ?? 0;
    const pnl = this.parseNumber(raw.totalPnlAfterFees ?? raw.pnl) ?? 0;
    const adjustedCollateral = collateral > 1e20 ? collateral / 1e30 : collateral;
    const adjustedPnl = pnl > 1e20 ? pnl / 1e30 : pnl;

    return {
      roi_pct: adjustedCollateral > 0 ? (adjustedPnl / adjustedCollateral) * 100 : null,
      pnl_usd: adjustedPnl,
      win_rate: this.parseNumber(raw.winRate),
      max_drawdown: null,
      trades_count: this.parseNumber(raw.totalTrades ?? raw.tradeCount) as number | null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: adjustedCollateral || null,
    };
  }
}

interface GmxAccountStat {
  id: string;
  account: string;
  totalPnlAfterFees: string;
  totalCollateral: string;
  totalTrades: number;
  winCount: number;
  lossCount: number;
  maxCollateral: string;
  timestamp: number;
}
