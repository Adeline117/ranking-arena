/**
 * Shared types for the PK (trader comparison) page.
 */

// ─── Public types ────────────────────────────────────────────────────────────

export interface PKTraderData {
  handle: string
  display_name: string
  avatar_url: string | null
  source: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  rank: number | null
  trades_count: number | null
}

export interface MetricRow {
  label: string
  a_raw: number | null
  b_raw: number | null
  a_display: string
  b_display: string
  /** 'a' | 'b' | 'tie' | null (null = not comparable) */
  winner: 'a' | 'b' | 'tie' | null
}

// ─── Internal DB row types ───────────────────────────────────────────────────

export type TraderSourceRow = {
  handle: string
  avatar_url: string | null
  source: string
  source_trader_id: string
}

export type LeaderboardRow = {
  display_name: string | null
  rank: number | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
}

export type SnapshotRow = {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  arena_score: number | null
}

// ─── Overall winner result ───────────────────────────────────────────────────

export interface OverallResult {
  winner: string | null
  aWins: number
  bWins: number
  total: number
}
