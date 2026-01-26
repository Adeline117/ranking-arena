/**
 * Dune Analytics DeFi Wallet Activity Connector
 *
 * Fetches general DeFi wallet activity data from Dune Analytics.
 * Query analyzes cross-chain transactions for active DeFi wallets.
 *
 * Note: This tracks wallet activity across multiple DeFi protocols,
 * ranking by total volume and protocol diversity.
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
const DUNE_DEFI_QUERY_ID = process.env.DUNE_DEFI_QUERY_ID || '0'; // Placeholder

export class DuneDefiConnector extends DuneBaseConnector {
  platform: Platform = 'dune_defi';
  market_type: MarketType = 'web3';
  queryId = DUNE_DEFI_QUERY_ID;
  queryName = 'DeFi Wallets';

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
    // Default to Ethereum mainnet explorer
    return `https://etherscan.io/address/${address}`;
  }

  normalize(raw: Record<string, unknown>): Partial<SnapshotMetrics> {
    const totalVolume = this.parseNumber(raw.total_volume ?? raw.volume_usd);
    const protocolsUsed = this.parseNumber(raw.protocols_used);

    // Calculate a simple "activity score" based on volume and protocol diversity
    let activityScore: number | null = null;
    if (totalVolume != null && protocolsUsed != null && protocolsUsed > 0) {
      // Score = log(volume) * protocol_diversity_factor
      activityScore = Math.log10(Math.max(totalVolume, 1)) * Math.min(protocolsUsed, 10);
    }

    return {
      // DeFi wallets don't have traditional ROI tracking
      roi_pct: null,
      // Use volume as proxy for activity level
      pnl_usd: totalVolume,
      win_rate: null,
      max_drawdown: null,
      trades_count: this.parseNumber(raw.tx_count ?? raw.transactions) as number | null,
      followers: null,
      copiers: null,
      sharpe_ratio: null,
      // Could be portfolio value if available
      aum: this.parseNumber(raw.portfolio_value ?? raw.total_value),
      // Extended metrics for DeFi activity
      protocols_used: protocolsUsed,
      activity_score: activityScore,
    } as Partial<SnapshotMetrics>;
  }
}

/**
 * Example Dune SQL Query to create for DeFi Activity:
 *
 * 重要：crosschain.transactions 可能不存在，需要组合多个协议的表。
 * 先验证可用的表：
 * SELECT * FROM aave_v3_ethereum.borrow LIMIT 10
 * SELECT * FROM dex.trades LIMIT 10
 *
 * 推荐使用组合查询：
 * ```sql
 * WITH defi_activity AS (
 *   -- Aave 借贷
 *   SELECT tx_from as address, 'aave' as protocol, amount_usd
 *   FROM aave_v3_ethereum.borrow
 *   WHERE block_time > NOW() - INTERVAL '{{days}} days'
 *     AND amount_usd > 0
 *
 *   UNION ALL
 *
 *   -- Uniswap 交易
 *   SELECT taker as address, 'uniswap' as protocol, amount_usd
 *   FROM dex.trades
 *   WHERE project = 'uniswap'
 *     AND block_time > NOW() - INTERVAL '{{days}} days'
 *     AND amount_usd > 0
 *
 *   -- 可以添加更多协议...
 * )
 * SELECT
 *   address,
 *   COUNT(DISTINCT protocol) as protocols_used,
 *   SUM(amount_usd) as total_volume,
 *   COUNT(*) as tx_count
 * FROM defi_activity
 * GROUP BY address
 * HAVING COUNT(DISTINCT protocol) >= 2  -- 至少使用 2 个协议
 *   AND SUM(amount_usd) > 1000  -- 最小交易量阈值
 * ORDER BY total_volume DESC
 * LIMIT 500
 * ```
 *
 * 注意：
 * - DeFi 钱包活动按交易量排名，不反映收益或技能
 * - 表名和字段名因协议而异，请在 Dune 确认
 * - 创建查询后，将 Query ID 设置到 DUNE_DEFI_QUERY_ID 环境变量
 */
