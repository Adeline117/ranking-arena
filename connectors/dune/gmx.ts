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
 * 重要：在创建查询前，先在 Dune 验证表和字段是否存在：
 * SELECT * FROM gmx_v2_arbitrum.position_decrease LIMIT 10
 *
 * 表名可能是 gmx_v2_arbitrum.position_decrease 或其他，请在 Dune 搜索确认。
 *
 * ```sql
 * SELECT
 *   account as address,
 *   SUM(realized_pnl_usd) as total_pnl,
 *   -- 近似 ROI：PnL / 保证金，添加最小分母阈值避免极端值
 *   CASE
 *     WHEN SUM(ABS(collateral_delta_usd)) > 100
 *     THEN SUM(realized_pnl_usd) / SUM(ABS(collateral_delta_usd)) * 100
 *     ELSE NULL
 *   END as roi_pct,
 *   COUNT(*) as trade_count,
 *   SUM(CASE WHEN realized_pnl_usd > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as win_rate
 * FROM gmx_v2_arbitrum.position_decrease  -- 确认实际表名
 * WHERE block_time > NOW() - INTERVAL '{{days}} days'
 *   AND realized_pnl_usd IS NOT NULL
 * GROUP BY account
 * HAVING COUNT(*) >= 5
 *   AND SUM(ABS(collateral_delta_usd)) > 100  -- 最小保证金阈值
 * ORDER BY total_pnl DESC
 * LIMIT 500
 * ```
 *
 * 注意：
 * - ROI 是近似值，计算方式为 PnL/保证金，不同于 CEX 的标准 ROI
 * - ORDER BY total_pnl 会让本金大的人排前面，不一定反映交易技能
 * - 创建查询后，将 Query ID 设置到 DUNE_GMX_QUERY_ID 环境变量
 */
