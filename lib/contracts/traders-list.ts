/**
 * Transport-neutral response type for GET /api/traders (homepage list).
 *
 * The route annotates its payload with this type and clients read the parsed
 * JSON through it. lib/contracts/core-api.ts asserts it still satisfies the
 * runtime zod contract, so a drift between route, client, and contract fails
 * type-checking. Keep this module free of Next.js route/runtime imports.
 */
import type { AntiGamingFlagCode } from '@/lib/scoring/anti-gaming'
import type { SourceFreshnessStatus } from '@/lib/rankings/source-freshness'

export type PublicTradersPeriod = '7D' | '30D' | '90D'

/** One published row. Null metrics mean the source did not provide them. */
export interface PublicTradersListTrader {
  id: string
  /** Profanity-sanitized; an empty string when the source name is a placeholder. */
  handle: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  copiers: number | null
  source: string
  source_type: string
  avatar_url: string | null
  /** Added by the avatar mirror enrichment when a mirror exists. */
  avatar_url_mirror?: string | null
  arena_score: number | null
  /** Persisted publication rank. */
  rank: number
  rank_change: number | null
  is_new: boolean
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | null
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
  is_bot: boolean
  trader_type: string | null
  is_outlier: boolean
  /** No ROI and no PnL in this window: ranked at the tail, not scored. */
  idle_window: boolean
  /** The reported drawdown was refused; max_drawdown is null. */
  mdd_contradiction: boolean
  computed_at: string | null
  anti_gaming_flags: AntiGamingFlagCode[]
  is_verified_data: boolean
  /** Present (true) only for a claimed trader profile. */
  is_verified?: boolean
  updated_at: string | null
  is_stale: boolean
}

export interface PublicTradersListResponse {
  traders: PublicTradersListTrader[]
  timeRange: PublicTradersPeriod
  totalCount: number | null
  totalCountIsExact: boolean
  /** The view column used for ordering (the requested sortBy). */
  rankingMode: string
  lastUpdated: string | null
  isStale: boolean
  dataAgeMinutes: number | null
  source_freshness: SourceFreshnessStatus[]
  nextCursor: number | null
  hasMore: boolean
  /** Echoed only for legacy page-based requests. */
  page?: number
  limit: number
  availableSources: string[]
  ranking_visibility?: 'partial'
  ranking_visibility_reason?: 'publication_policy_filtered' | 'source_freshness_unverified'
  ranking_visibility_reasons?: readonly string[]
}
