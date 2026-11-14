/**
 * Transport-neutral response type for GET /api/rankings (the `data` member of
 * the standard success envelope).
 *
 * The route annotates every payload it sends with this type, and
 * lib/contracts/core-api.ts asserts it against the runtime zod contract.
 * Keep this module free of Next.js route/runtime imports.
 */
import type { Platform } from '@/lib/types/leaderboard'
import type { SourceFreshnessStatus } from '@/lib/rankings/source-freshness'

/** `composite` requests answer with `COMPOSITE`; the cohort is the 90D season. */
export type PublicRankingsWindow = '7D' | '30D' | '90D' | 'COMPOSITE'

export type PublicRankingsSortBy =
  | 'arena_score'
  | 'roi'
  | 'pnl'
  | 'drawdown'
  | 'copiers'
  | 'win_rate'
  | 'sharpe_ratio'
  | 'trades_count'

/** One published row. Null metrics mean the source did not provide them. */
export interface PublicRankingsTrader {
  platform: Platform
  trader_key: string
  display_name: string
  avatar_url: string | null
  roi: number | null
  pnl: number | null
  arena_score: number | null
  win_rate: number | null
  max_drawdown: number | null
  sharpe_ratio: number | null
  trades_count: number | null
  followers: number | null
  copiers: number | null
  /** Persisted publication rank. */
  rank: number
  rank_change: number | null
  is_new: boolean
  quality_flags: { is_suspicious: boolean; suspicion_reasons: string[]; data_completeness: number }
  updated_at: string | null
  is_stale: boolean
  computed_at: string | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | null
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  is_bot: boolean
  trader_type: string | null
}

export interface PublicRankingsData {
  traders: PublicRankingsTrader[]
  window: PublicRankingsWindow
  totalCount: number | null
  totalCountIsExact: boolean
  /** Legacy spellings of totalCount, kept for older clients. */
  totalcount: number | null
  total_count: number | null
  as_of: string | null
  is_stale: boolean
  source_freshness: SourceFreshnessStatus[]
  availableSources: string[]
  availableSourcesIsExact: boolean
  /** This endpoint has no cursor pagination. */
  next_cursor: null
  hasMore: boolean
  rankingMode: PublicRankingsSortBy
  sort_by: PublicRankingsSortBy
  sort_dir: 'asc' | 'desc'
  limit: number
  offset: number
  ranking_visibility?: 'partial'
  ranking_visibility_reason?: 'publication_policy_filtered' | 'source_freshness_unverified'
  ranking_visibility_reasons?: readonly string[]
}
