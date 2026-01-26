/**
 * Dune Analytics Hyperliquid Connector
 *
 * Fetches Hyperliquid perpetual traders data from Dune Analytics.
 * Query analyzes hyperliquid.trades for top PnL traders.
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
const DUNE_HYPERLIQUID_QUERY_ID = process.env.DUNE_HYPERLIQUID_QUERY_ID || '0'; // Placeholder

export class DuneHyperliquidConnector extends DuneBaseConnector {
  platform: Platform = 'dune_hyperliquid';
  market_type: MarketType = 'perp';
  queryId = DUNE_HYPERLIQUID_QUERY_ID;
  queryName = 'Hyperliquid';

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
    // Hyperliquid uses EVM addresses, can link to Arbiscan or custom explorer
    return `https://app.hyperliquid.xyz/explorer/${address}`;
  }

  normalize(raw: Record<string, unknown>): Partial<SnapshotMetrics> {
    return {
      roi_pct: this.parseNumber(raw.roi_pct ?? raw.roi),
      pnl_usd: this.parseNumber(raw.total_pnl ?? raw.pnl),
      win_rate: this.parseNumber(raw.win_rate),
      max_drawdown: null, // Hyperliquid doesn't track drawdown directly
      trades_count: this.parseNumber(raw.trade_count ?? raw.trades) as number | null,
      followers: null, // On-chain, no followers
      copiers: null, // On-chain, no copiers
      sharpe_ratio: null,
      aum: this.parseNumber(raw.margin ?? raw.total_margin),
    };
  }
}

/**
 * Example Dune SQL Query to create for Hyperliquid:
 *
 * ```sql
 * SELECT
 *   user_address as address,
 *   SUM(pnl) as total_pnl,
 *   SUM(pnl) / NULLIF(SUM(margin), 0) * 100 as roi_pct,
 *   COUNT(*) as trade_count,
 *   SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate,
 *   SUM(margin) as total_margin
 * FROM hyperliquid.trades
 * WHERE block_time > NOW() - INTERVAL '{{days}} days'
 * GROUP BY user_address
 * HAVING COUNT(*) >= 5
 * ORDER BY total_pnl DESC
 * LIMIT 500
 * ```
 *
 * After creating this query on Dune, set the query ID in DUNE_HYPERLIQUID_QUERY_ID env var.
 */
