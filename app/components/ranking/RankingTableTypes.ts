// Column customization types
export type ColumnKey =
  | 'score'
  | 'roi'
  | 'pnl'
  | 'winrate'
  | 'mdd'
  | 'sharpe'
  | 'sortino'
  | 'style'
  | 'followers'
  | 'trades'

// All columns users can toggle (sharpe, followers, trades added per P1-2/3/4)
export const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = [
  'score',
  'roi',
  'pnl',
  'winrate',
  'mdd',
  'sharpe',
  'followers',
  'trades',
]
export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'pnl', 'winrate', 'mdd']
export const LS_KEY_COLUMNS = 'ranking-visible-columns'
// View mode type — auto-detected only (mobile→card, desktop→table), no manual toggle
export type ViewMode = 'table' | 'card'
export const MOBILE_CARD_MEDIA_QUERY = '(max-width: 767px)'

type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches'>

/**
 * Resolve the ranking layout before the first client paint.
 *
 * The interactive homepage is mounted behind a client-only boundary, so it is
 * safe to read the viewport here. Falling back to table keeps non-browser test
 * and tooling environments deterministic.
 */
export function getInitialRankingViewMode(
  matchMedia: MatchMedia | null | undefined = typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function'
    ? window.matchMedia.bind(window)
    : undefined
): ViewMode {
  return matchMedia?.(MOBILE_CARD_MEDIA_QUERY).matches ? 'card' : 'table'
}

/** Public leaderboard sort fields with a verifiable source contract. */
export type SortColumn = 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino'
export type SortDir = 'asc' | 'desc'
export type ScoreGrade = 'S' | 'A' | 'B' | 'C' | 'D'

/**
 * Preserve an absent score as absent, but turn a corrupt numeric payload into
 * an explicit unknown before it reaches a score presentation component.
 */
export function normalizeFiniteScore(score: number | null | undefined): number | null | undefined {
  return score == null || Number.isFinite(score) ? score : null
}

/**
 * Ranking-table score tiers. Missing, corrupt, or non-finite source scores do
 * not have a grade and must never be represented as the zero-score D tier.
 */
export function scoreGradeOf(score: number | null | undefined): ScoreGrade | null {
  if (score == null || !Number.isFinite(score)) return null
  if (score >= 90) return 'S'
  if (score >= 70) return 'A'
  if (score >= 50) return 'B'
  if (score >= 30) return 'C'
  return 'D'
}

export function getStoredColumns(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLUMNS
  try {
    const stored = localStorage.getItem(LS_KEY_COLUMNS)
    if (stored) {
      const parsed = JSON.parse(stored) as unknown
      if (Array.isArray(parsed) && parsed.every((c) => typeof c === 'string')) {
        // Migrate old local preferences that included the retired alpha
        // column instead of discarding every other valid preference.
        const supported = parsed.filter((c): c is ColumnKey =>
          ALL_TOGGLEABLE_COLUMNS.includes(c as ColumnKey)
        )
        if (supported.length > 0) return supported
      }
    }
  } catch {
    /* ignore */
  }
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
  /** Null is an unknown source metric, never a synthetic zero. */
  roi: number | null
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers: number
  /** Exchange copier count (populated; `followers` is 0 for ~all rows). The
   *  Followers column renders `copiers ?? followers` (audit 2026-07-03). */
  copiers?: number | null
  source?: string
  avatar_url?: string | null
  /** Existing Supabase-Storage mirror, preferred when it remains direct-safe. */
  avatar_url_mirror?: string | null
  arena_score?: number | null
  /** Pre-computed rank from leaderboard_ranks DB table */
  rank?: number | null
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
  profit_factor?: number | null
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
  trader_type?: 'human' | 'bot' | 'suspected_bot' | null
  /** Whether this trader is a bot */
  is_bot?: boolean
  /** Bot category */
  bot_category?: string | null
  /** Whether this trader is verified (claimed profile) */
  is_verified?: boolean
  /** Whether win_rate/max_drawdown were estimated from ROI (not from exchange data) */
  metrics_estimated?: boolean
  /** Trust-facing anti-gaming flag codes (statistical-anomaly ⚠️ badges).
   *  See lib/scoring/anti-gaming.ts. Empty/undefined = nothing flagged. */
  anti_gaming_flags?: string[]
  /** A1 data-authenticity: trades confirmed via a connected read-only API key
   *  (vs scraped "Tracked"). Drives the ✓ Verified badge. */
  is_verified_data?: boolean
}

/**
 * UI-only score boundary. This intentionally leaves every other field and the
 * persisted rank untouched: corrupt score values become unknown only for
 * presentation components.
 */
export function normalizeTraderArenaScoreForPresentation(trader: Trader): Trader {
  const arenaScore = normalizeFiniteScore(trader.arena_score)
  return Object.is(arenaScore, trader.arena_score) ? trader : { ...trader, arena_score: arenaScore }
}

export type PublishedRankTrader = Trader & { rank: number }

/**
 * A ranking UI may display only the persisted publication authority's rank.
 * Array position, filtered position, and page offsets are never rank evidence.
 */
export function hasPublishedTraderRank(trader: Trader): trader is PublishedRankTrader {
  return Number.isSafeInteger(trader.rank) && Number(trader.rank) > 0
}

export function selectPublishedRankTraders(traders: readonly Trader[]): PublishedRankTrader[] {
  return traders.filter(hasPublishedTraderRank)
}

export function selectTopPublishedRankTraders(
  traders: readonly Trader[],
  limit = 3
): PublishedRankTrader[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return []
  return selectPublishedRankTraders(traders)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
}
