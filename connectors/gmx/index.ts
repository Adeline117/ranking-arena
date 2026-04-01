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

// GMX V2 Arbitrum - Subsquid GraphQL API (replaces deprecated Satsuma subgraph)
const SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const GMX_APP = 'https://app.gmx.io';

// Subsquid uses 1e30 scale for values
const VALUE_SCALE = 1e30;

/** Safely convert a subgraph BigInt string to Number. Handles null, undefined, empty, decimal strings. */
function safeBigIntToNum(val: string | number | null | undefined, scale: number): number {
  if (val == null || val === '') return 0;
  try {
    // Remove decimal portion if present (subgraph sometimes returns "123.0")
    const str = String(val).split('.')[0];
    return Number(BigInt(str)) / scale;
  } catch {
    return 0;
  }
}

export class GmxConnector extends BaseConnector {
  platform: Platform = 'gmx';
  market_type: MarketType = 'perp';

  protected rate_limit = { rpm: 30, concurrent: 3, delay_ms: 2000 };

  async discoverLeaderboard(window: Window, limit = 100): Promise<ConnectorResult<LeaderboardEntry[]>> {
    try {
      // GMX leaderboard via Subsquid GraphQL API
      // Query accountStats which contains cumulative trading data
      const query = `{
        accountStats(
          limit: ${Math.min(limit * 2, 2000)},
          orderBy: realizedPnl_DESC
        ) {
          id
          wins
          losses
          realizedPnl
          volume
          netCapital
          maxCapital
          closedCount
        }
      }`;

      const response = await this.postJSON<{ data: { accountStats: GmxSubsquidAccountStat[] } }>(
        SUBSQUID_URL,
        { query },
      );

      if (!response?.data?.accountStats) {
        // Fallback: try the leaderboard API
        return this.tryLeaderboardApi(window, limit);
      }

      const entries: LeaderboardEntry[] = response.data.accountStats
        .map((item, idx) => {
          // Values are in wei (1e30 scale)
          const pnl = safeBigIntToNum(item.realizedPnl, VALUE_SCALE);
          const volume = safeBigIntToNum(item.volume, VALUE_SCALE);
          const netCapital = safeBigIntToNum(item.netCapital, VALUE_SCALE);
          const maxCapital = safeBigIntToNum(item.maxCapital, VALUE_SCALE);

          // Calculate ROI based on max capital deployed
          // Avoid division by zero and unrealistic ROI from tiny positions
          const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0;

          const totalTrades = (item.wins || 0) + (item.losses || 0);
          const winRate = totalTrades > 0 ? (item.wins / totalTrades) * 100 : null;

          return {
            trader_key: item.id.toLowerCase(),
            display_name: `${item.id.slice(0, 6)}...${item.id.slice(-4)}`,
            avatar_url: null,
            profile_url: `${GMX_APP}/#/actions/${item.id}`,
            rank: idx + 1,
            metrics: {
              roi_pct: roi,
              pnl_usd: pnl,
              win_rate: winRate,
              max_drawdown: null,
              trades_count: item.closedCount || totalTrades,
              followers: null,
              copiers: null,
              sharpe_ratio: null,
              aum: netCapital > 0 ? netCapital : maxCapital,
              volume,
            },
            raw: item as unknown as Record<string, unknown>,
          };
        })
        // Filter out traders with unrealistic data
        .filter(e => {
          const roi = e.metrics.roi_pct ?? 0;
          const pnl = e.metrics.pnl_usd ?? 0;
          return roi >= -100 && roi <= 10000 && pnl >= -10000000 && pnl <= 100000000;
        })
        // Sort by ROI descending
        .sort((a, b) => ((b.metrics.roi_pct ?? -Infinity) - (a.metrics.roi_pct ?? -Infinity)));

      return this.success(entries.slice(0, limit), {
        source_url: SUBSQUID_URL,
        platform_sorting: 'roi_desc',
        platform_window: window,
        reason: 'Subsquid data is cumulative (all-time), sorted client-side by ROI',
      }, { window_not_supported: true, reason: 'Subsquid provides cumulative data only' });
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
      // Query specific trader from Subsquid
      const query = `{
        accountStats(
          where: { id_eq: "${trader_key.toLowerCase()}" }
          limit: 1
        ) {
          id
          wins
          losses
          realizedPnl
          volume
          netCapital
          maxCapital
          closedCount
        }
      }`;

      const response = await this.postJSON<{ data: { accountStats: GmxSubsquidAccountStat[] } }>(
        SUBSQUID_URL,
        { query },
      );

      const stats = response?.data?.accountStats?.[0];
      if (!stats) return this.failure('No on-chain stats found for this trader');

      // Values are in wei (1e30 scale)
      const pnl = safeBigIntToNum(stats.realizedPnl, VALUE_SCALE);
      const _volume = safeBigIntToNum(stats.volume, VALUE_SCALE);
      const netCapital = safeBigIntToNum(stats.netCapital, VALUE_SCALE);
      const maxCapital = safeBigIntToNum(stats.maxCapital, VALUE_SCALE);

      // Calculate ROI based on max capital deployed
      const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0;

      const totalTrades = (stats.wins || 0) + (stats.losses || 0);
      const winRate = totalTrades > 0 ? (stats.wins / totalTrades) * 100 : null;

      const metrics: SnapshotMetrics = {
        roi_pct: roi,
        pnl_usd: pnl,
        win_rate: winRate,
        max_drawdown: null,
        trades_count: stats.closedCount || totalTrades,
        followers: null,
        copiers: null,
        sharpe_ratio: null,
        aum: netCapital > 0 ? netCapital : maxCapital,
        roi_type: 'realized',
      };

      return this.success<CanonicalSnapshot>({
        platform: 'gmx',
        market_type: 'perp',
        trader_key,
        window,
        as_of_ts: new Date().toISOString(),
        metrics,
        quality_flags: {
          missing_drawdown: true,
          missing_sharpe: true,
          window_not_supported: true,
          reason: 'Subsquid provides cumulative (all-time) data only, window parameter ignored',
        },
        provenance: this.buildProvenance(SUBSQUID_URL, { platform_sorting: 'roi_desc', platform_window: window }),
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

// Legacy interface for old Satsuma subgraph (deprecated)
interface _GmxAccountStat {
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

// New interface for Subsquid GraphQL API
interface GmxSubsquidAccountStat {
  id: string;              // Wallet address
  wins: number;            // Number of winning trades
  losses: number;          // Number of losing trades
  realizedPnl: string;     // Total realized PnL in wei (1e30 scale)
  volume: string;          // Total trading volume in wei
  netCapital: string;      // Net capital (deposits - withdrawals)
  maxCapital: string;      // Maximum capital deployed
  closedCount: number;     // Number of closed positions
}
