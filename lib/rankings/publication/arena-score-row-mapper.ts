import type { SourcePublicationScoreRow } from './source-publication-evidence'
import type { TraderRow } from './trader-row'

export type ArenaScoreRowForTrader = Pick<
  SourcePublicationScoreRow,
  | 'platform'
  | 'trader_key'
  | 'roi_pct'
  | 'pnl_usd'
  | 'win_rate'
  | 'max_drawdown'
  | 'copiers'
  | 'trades_count'
  | 'sharpe_ratio'
  | 'sortino_ratio'
  | 'calmar_ratio'
  | 'trader_kind'
  | 'as_of'
  | 'board_as_of'
>

/**
 * Project one already-normalized arena score row into the canonical compute
 * input shape. Boundary validation/coercion belongs to the caller; this pure
 * mapper deliberately performs no parsing and never mutates its input.
 */
export function mapArenaScoreRowToTraderRow(row: ArenaScoreRowForTrader): TraderRow {
  return {
    source: row.platform,
    source_trader_id: row.trader_key,
    roi: row.roi_pct,
    pnl: row.pnl_usd,
    win_rate: row.win_rate,
    max_drawdown: row.max_drawdown,
    trades_count: row.trades_count,
    followers: null,
    copiers: row.copiers,
    arena_score: null,
    captured_at: row.as_of,
    source_board_as_of: row.board_as_of,
    full_confidence_at: null,
    profitability_score: null,
    risk_control_score: null,
    execution_score: null,
    score_completeness: null,
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    sharpe_ratio: row.sharpe_ratio,
    sortino_ratio: row.sortino_ratio,
    profit_factor: null,
    calmar_ratio: row.calmar_ratio,
    trader_type: row.trader_kind === 'bot' ? 'bot' : null,
    metrics_estimated: false,
  }
}
