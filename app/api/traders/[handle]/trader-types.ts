/**
 * Type definitions for the trader detail API.
 *
 * @deprecated Most types here are superseded by UnifiedTrader in lib/types/unified-trader.ts.
 * New code should import from unified-trader.ts. These types remain for backward compatibility.
 */

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderSource {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  avatar_url: string | null
  market_type: string | null
}

export interface SnapshotData {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count?: number | null
  followers?: number | null
  captured_at?: string
  season_id?: string
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  arena_score?: number | null
  arena_score_v3?: number | null
  score_completeness?: string | null
  score_penalty?: number | null
  sharpe_ratio?: number | null
}

export interface AssetBreakdownItem {
  symbol: string
  weight_pct: number
  period: string
}

export interface EquityCurvePoint {
  data_date: string
  roi_pct: number | null
  pnl_usd: number | null
}

export interface PortfolioItem {
  symbol: string | null
  direction: string | null
  invested_pct: number | null
  entry_price: number | null
  pnl: number | null
}

export interface PositionHistoryItem {
  symbol: string
  direction: string
  position_type: string | null
  margin_mode: string | null
  open_time: string | null
  close_time: string | null
  entry_price: number | null
  exit_price: number | null
  max_position_size: number | null
  closed_size: number | null
  pnl_usd: number | null
  pnl_pct: number | null
  status: string | null
}

export interface StatsDetailData {
  sharpe_ratio: number | null
  copiers_pnl: number | null
  copiers_count: number | null
  winning_positions: number | null
  total_positions: number | null
  total_trades: number | null
  avg_holding_time_hours: number | null
  avg_profit: number | null
  avg_loss: number | null
  aum: number | null
  period: string | null
}
