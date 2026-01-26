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
 * 重要：在创建查询前，先在 Dune 验证表和字段是否存在：
 * SELECT * FROM dex.trades WHERE project = 'uniswap' LIMIT 10
 *
 * 字段名可能是 trader, taker, tx_from 等，请确认实际字段名。
 *
 * ```sql
 * SELECT
 *   taker as address,  -- 字段名可能不同，请确认
 *   SUM(amount_usd) as total_volume,
 *   COUNT(*) as swap_count,
 *   COUNT(DISTINCT token_bought_address) as tokens_traded
 * FROM dex.trades
 * WHERE project = 'uniswap'
 *   AND block_time > NOW() - INTERVAL '{{days}} days'
 *   AND amount_usd > 0
 * GROUP BY taker
 * HAVING SUM(amount_usd) > 10000  -- 最小交易量阈值
 * ORDER BY total_volume DESC
 * LIMIT 500
 * ```
 *
 * 注意：
 * - Uniswap 是现货 DEX，没有 PnL/ROI 概念，只能按交易量排名
 * - 交易量大不代表交易技能高，仅反映活跃度
 * - 创建查询后，将 Query ID 设置到 DUNE_UNISWAP_QUERY_ID 环境变量
 */
