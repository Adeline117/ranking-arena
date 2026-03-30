// Column customization types
export type ColumnKey = 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sharpe' | 'sortino' | 'alpha' | 'style' | 'followers' | 'trades'

// All columns users can toggle (sharpe, followers, trades added per P1-2/3/4)
export const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'pnl', 'winrate', 'mdd', 'sharpe', 'followers', 'trades']
export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'pnl', 'winrate', 'mdd']
export const LS_KEY_COLUMNS = 'ranking-visible-columns'
export const LS_KEY_VIEW_MODE = 'ranking-view-mode'
export const LS_KEY_VIEW_MANUAL = 'ranking-view-manual'

// View mode type
export type ViewMode = 'table' | 'card'

export type SortColumn = 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'
export type SortDir = 'asc' | 'desc'

export function getStoredViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'table'
  try {
    const stored = localStorage.getItem(LS_KEY_VIEW_MODE)
    if (stored === 'table' || stored === 'card') return stored
  } catch { /* ignore */ }
  return 'table'
}

export function getStoredManualFlag(): boolean {
  if (typeof window === 'undefined') return false
  try { return localStorage.getItem(LS_KEY_VIEW_MANUAL) === 'true' } catch { return false }
}

export function getStoredColumns(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLUMNS
  try {
    const stored = localStorage.getItem(LS_KEY_COLUMNS)
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnKey[]
      if (Array.isArray(parsed) && parsed.every(c => ALL_TOGGLEABLE_COLUMNS.includes(c))) {
        return parsed
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE_COLUMNS
}

/**
 * UI-specific Trader interface for ranking table components.
 * Uses snake_case field names to match the database/API response shape
 * that ranking components consume directly.
 *
 * For server-side data access, use UnifiedTrader from lib/data/trader/types.
 */
export interface Trader {
  id: string
  handle: string | null
  display_name?: string | null
  roi: number
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers: number
  source?: string
  avatar_url?: string | null
  arena_score?: number
  return_score?: number
  pnl_score?: number
  drawdown_score?: number
  stability_score?: number
  score_confidence?: 'full' | 'partial' | 'minimal' | null
  rank_change?: number | null
  is_new?: boolean
  also_on?: string[]
  // V3 Advanced Metrics
  sortino_ratio?: number | null
  calmar_ratio?: number | null
  alpha?: number | null
  arena_score_v3?: number | null
  trading_style?: string | null
  style_confidence?: number | null
  // Score breakdown
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  score_completeness?: 'full' | 'partial' | 'minimal' | null
  avg_holding_hours?: number | null
  sharpe_ratio?: number | null
  trader_type?: 'human' | 'bot' | null
  /** Whether this trader is a bot */
  is_bot?: boolean
  /** Bot category */
  bot_category?: string | null
  /** Whether this trader is verified (claimed profile) */
  is_verified?: boolean
  /** Whether win_rate/max_drawdown were estimated from ROI (not from exchange data) */
  metrics_estimated?: boolean
}
