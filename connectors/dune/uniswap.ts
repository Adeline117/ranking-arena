/**
 * Dune Analytics Uniswap Connector
 *
 * Fetches Uniswap DEX spot traders data from Dune Analytics.
 * Query analyzes dex.trades for top volume traders on Uniswap.
 *
 * Note: Uniswap is a spot DEX, so we track volume rather than PnL.
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
const DUNE_UNISWAP_QUERY_ID = process.env.DUNE_UNISWAP_QUERY_ID || '0'; // Placeholder

export class DuneUniswapConnector extends DuneBaseConnector {
  platform: Platform = 'dune_uniswap';
  market_type: MarketType = 'spot';
  queryId = DUNE_UNISWAP_QUERY_ID;
  queryName = 'Uniswap';

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
    return `https://etherscan.io/address/${address}`;
  }

  normalize(raw: Record<string, unknown>): Partial<SnapshotMetrics> {
    // Uniswap tracks volume, not PnL - we use volume-based metrics
    const totalVolume = this.parseNumber(raw.total_volume ?? raw.volume_usd);

    return {
      // For spot DEX, ROI doesn't apply - we use volume metrics
      roi_pct: null,
      // Use volume as "pnl" proxy for ranking purposes
      pnl_usd: totalVolume,
      win_rate: null, // Not applicable for spot DEX
      max_drawdown: null,
      trades_count: this.parseNumber(raw.swap_count ?? raw.trades) as number | null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      aum: null,
      // Store volume in extended metrics
      total_volume: totalVolume,
      tokens_traded: this.parseNumber(raw.tokens_traded) as number | null,
    } as Partial<SnapshotMetrics>;
  }
}

/**
 * Example Dune SQL Query to create for Uniswap:
 *
 * ```sql
 * SELECT
 *   trader as address,
 *   SUM(amount_usd) as total_volume,
 *   COUNT(*) as swap_count,
 *   COUNT(DISTINCT token_bought_address) as tokens_traded
 * FROM dex.trades
 * WHERE project = 'uniswap'
 *   AND block_time > NOW() - INTERVAL '{{days}} days'
 * GROUP BY trader
 * HAVING SUM(amount_usd) > 10000
 * ORDER BY total_volume DESC
 * LIMIT 500
 * ```
 *
 * After creating this query on Dune, set the query ID in DUNE_UNISWAP_QUERY_ID env var.
 */
