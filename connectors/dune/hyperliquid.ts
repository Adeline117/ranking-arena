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
 * 重要：在创建查询前，先在 Dune 验证表和字段是否存在：
 * SELECT * FROM hyperliquid.trades LIMIT 10
 * -- 或者
 * SELECT * FROM dex_perp.trades WHERE project = 'hyperliquid' LIMIT 10
 *
 * 表名和字段名可能不同，请在 Dune Data Explorer 搜索确认。
 *
 * ```sql
 * SELECT
 *   user_address as address,
 *   SUM(pnl) as total_pnl,
 *   -- 近似 ROI：添加最小分母阈值
 *   CASE
 *     WHEN SUM(ABS(margin)) > 100
 *     THEN SUM(pnl) / SUM(ABS(margin)) * 100
 *     ELSE NULL
 *   END as roi_pct,
 *   COUNT(*) as trade_count,
 *   SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate,
 *   SUM(margin) as total_margin
 * FROM hyperliquid.trades  -- 确认实际表名
 * WHERE block_time > NOW() - INTERVAL '{{days}} days'
 * GROUP BY user_address
 * HAVING COUNT(*) >= 5
 *   AND SUM(ABS(margin)) > 100  -- 最小保证金阈值
 * ORDER BY total_pnl DESC
 * LIMIT 500
 * ```
 *
 * 注意：
 * - ROI 是近似值，可能被小额高杠杆交易极端放大
 * - 创建查询后，将 Query ID 设置到 DUNE_HYPERLIQUID_QUERY_ID 环境变量
 */
