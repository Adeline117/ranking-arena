/**
 * Dune Analytics GMX Connector
 *
 * Fetches GMX (Arbitrum) perpetual traders data from Dune Analytics.
 * Query analyzes gmx_v2_arbitrum.trades for top PnL traders.
 *
 * Required: DUNE_API_KEY environment variable
 */

import { DuneBaseConnector, DuneLeaderboardRow } from './base';
import type {
  Platform,
  MarketType,
  LeaderboardEntry,
  SnapshotMetrics,
} from '../base/types';

// Replace with actual Dune query ID after creating the query
// Query: Top GMX traders by PnL on Arbitrum (last 30 days)
const DUNE_GMX_QUERY_ID = process.env.DUNE_GMX_QUERY_ID || '0'; // Placeholder

export class DuneGmxConnector extends DuneBaseConnector {
  platform: Platform = 'dune_gmx';
  market_type: MarketType = 'perp';
  queryId = DUNE_GMX_QUERY_ID;
  queryName = 'GMX Arbitrum';

  protected rowToLeaderboardEntry(row: DuneLeaderboardRow, rank: number): LeaderboardEntry {
    return {
      trader_key: String(row.address).toLowerCase(),
      display_name: row.label || this.formatAddress(String(row.address)),
      avatar_url: null,
      profile_url: this.getExplorerUrl(String(row.address)),
      rank,
      metrics: this.normalize(row as unknown as Record<string, unknown>),
      raw: row as unknown as Record<string, unknown>,
    };
  }

  protected getExplorerUrl(address: string): string {
    return `https://arbiscan.io/address/${address}`;
  }

  normalize(raw: Record<string, unknown>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi_pct ?? raw.roi),
      pnl_usd: this.parseNumber(raw.total_pnl ?? raw.pnl),
      win_rate: this.parseNumber(raw.win_rate),
      max_drawdown: null, // GMX doesn't track drawdown directly
      trades_count: this.parseNumber(raw.trade_count ?? raw.trades) as number | null,
      followers: null, // On-chain, no followers
      copiers: null, // On-chain, no copiers
      sharpe_ratio: null,
      aum: null,
    };
  }
}

/**
 * Example Dune SQL Query to create for GMX:
 *
 * ```sql
 * SELECT
 *   account as address,
 *   SUM(realized_pnl) as total_pnl,
 *   SUM(realized_pnl) / NULLIF(SUM(ABS(collateral_delta)), 0) * 100 as roi_pct,
 *   COUNT(*) as trade_count,
 *   SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate,
 *   MAX(realized_pnl) - MIN(realized_pnl) as pnl_range
 * FROM gmx_v2_arbitrum.trades
 * WHERE block_time > NOW() - INTERVAL '{{days}} days'
 * GROUP BY account
 * HAVING COUNT(*) >= 5
 * ORDER BY total_pnl DESC
 * LIMIT 500
 * ```
 *
 * After creating this query on Dune, set the query ID in DUNE_GMX_QUERY_ID env var.
 */
