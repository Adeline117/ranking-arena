/**
 * Frontend contracts for the new serving layer (ARENA_DATA_SPEC v1.2 §2.4/§6).
 *
 * Components consume ONLY these shapes — whether the data came from the new
 * arena.* schema or the legacy tables is decided by the per-source cutover
 * flag and hidden behind the fetchers/legacy adapter. Money is never a bare
 * number (spec §5.8): summing across currencies must be a type-level error.
 */

export type ServingTimeframe = 7 | 30 | 90 | 'inception'
export type TfAvailability = 'native' | 'derived' | 'absent'
export type ServingCurrency = 'USDT' | 'USDx' | 'USDC' | 'USD'

export interface Provenance {
  /** Exchange/source slug, e.g. 'bitget_futures'. */
  source: string
  /** ISO UTC timestamp — snapshot scraped_at or stats as_of. Render-side
   *  converts to viewer-local time (spec §5.9). */
  asOf: string
  /** Derived board / derived timeframe (MEXC/BTCC, computed 90d). */
  derived?: boolean
}

export interface Money {
  value: number
  currency: ServingCurrency
}

/** Tier-A guarantee: renders with ZERO on-demand fetching (spec §2.4-1). */
export interface TraderFirstScreen {
  source: string
  exchangeTraderId: string
  nickname: string | null
  avatarMirrorUrl: string | null
  avatarOriginUrl: string | null
  /** Final renderable src (spec §1.4): mirror direct → proxied origin → null
   *  (null = caller renders gradient + initial fallback). */
  avatarSrc: string | null
  walletAddress: string | null
  traderKind: 'human' | 'bot'
  botStrategy: 'martingale' | 'grid' | 'ai' | null
  entries: Array<{
    timeframe: 7 | 30 | 90
    rank: number
    headlineRoi: number | null
    headlinePnl: Money | null
    headlineWinRate: number | null
    /** Board-card extras the source exposed (sparkline, MDD, copiers…) —
     *  projected from leaderboard_entries.raw via sources.meta.board_fields. */
    extras: Record<string, unknown>
    provenance: Provenance
  }>
}

/** /api/traders/[handle]/first-screen payload — used by the client-side
 *  ?platform= account disambiguation (the trader page is ISR-static, so the
 *  server component cannot read searchParams and resolves without a platform
 *  hint; the client validates + re-fetches the requested account here). */
export interface TraderFirstScreenResponse {
  /** Exact decoded selector that reached this transport boundary. */
  request: { platform: string; handle: string }
  /** Canonical serving identity resolved from the requested selector. */
  subject: { platform: string; traderKey: string }
  firstScreen: TraderFirstScreen
  capability: SourceCapability | null
  /** Active read-only API authorization: account data is first-party verified. */
  is_verified_data: boolean
}

export type CoreCacheState = 'warm' | 'cold-fetched' | 'pending'

/** One on-demand request per timeframe (spec §2.4-2). */
export interface TraderCoreModules {
  timeframe: ServingTimeframe
  /** Superset metric block; NULL = source doesn't expose it (NULL-collapse). */
  stats: Record<string, number | string | null>
  currency: ServingCurrency
  series: Record<string, Array<{ ts: string; value: number }>>
  extras: Record<string, unknown>
  provenance: Provenance
  cacheState: CoreCacheState
}

/** /core route payload: full modules, or a pending shell while Tier-C runs.
 *  A stale hit returns the stale TraderCoreModules with cacheState 'pending'
 *  (data renders immediately, the client keeps polling for fresh). */
export type TraderCoreResponse =
  | TraderCoreModules
  | { timeframe: ServingTimeframe; cacheState: 'pending' }

export type RecordKind = 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers'

/**
 * Trust state for closed-position history. `complete` is deliberately narrow:
 * callers may only emit it after binding terminal acquisition evidence to the
 * served page. Preview/on-demand reads stay `partial`; legacy warm reads whose
 * evidence is not yet joined stay `unknown`.
 */
export type HistoryCompletenessState = 'complete' | 'partial' | 'unknown'

export type HistoryCompletenessReason =
  | 'verified_terminal_history'
  | 'interactive_preview'
  | 'history_evidence_not_bound'

export type HistoryEvidenceState =
  | 'verified'
  | 'missing'
  | 'invalid'
  | 'verifier_missing'
  | 'rejected'
  | 'caller_limited'
  | 'upstream_error'

export type HistoryScanTerminalState = 'exhausted' | 'cursor_overlap' | 'partial' | 'unknown'

export type HistoryCompletenessBlockerReason =
  | 'terminal_claim_missing'
  | 'terminal_claim_invalid'
  | 'terminal_verifier_missing'
  | 'terminal_claim_rejected'
  | 'caller_limit'
  | 'upstream_error'

export interface HistoryCompleteness {
  state: HistoryCompletenessState
  reason: HistoryCompletenessReason
  evidenceState?: HistoryEvidenceState
  scanTerminalState?: HistoryScanTerminalState
  blockerReasons?: HistoryCompletenessBlockerReason[]
}

export interface RecordsPage<T = Record<string, unknown>> {
  rows: T[]
  nextCursor: string | null
  provenance: Provenance
  cacheState: CoreCacheState
  /** Present for position_history. Omitted for non-history record surfaces. */
  completeness?: HistoryCompleteness
}

/** Copier data is AGGREGATE-ONLY — no row-level identifiers, ever (spec §6). */
export interface CopierAggregate {
  copierCount: number | null
  copierCountMax: number | null
  totalCopierPnl: Money | null
  pnlDistribution: Array<{ bucket: string; count: number }>
  depth: 'full' | 'top10' | 'top3_preview' | 'none'
  provenance: Provenance
}

/** Capability matrix — data, not code (spec §6): derived from the sources
 *  row + observed non-NULL coverage; adding an exchange never touches UI. */
export interface SourceCapability {
  timeframes: Record<'7' | '30' | '90', TfAvailability>
  inceptionTf: boolean
  /** Superset stat keys this source actually exposes. */
  metrics: string[]
  surfaces: Record<RecordKind, boolean>
  copierDepth: 'full' | 'top10' | 'top3_preview' | 'none'
  currency: ServingCurrency
  isOnchain: boolean
  derivedBoardNote: boolean
  exchangeName: string
}
