/**
 * Canonical types for the unified ingestion framework (ARENA_DATA_SPEC v1.2).
 *
 * Everything in the system is classified by the four canonical dimensions
 * (spec §1): timeframe, product type, trader kind, identity. Adapters parse
 * source payloads into these shapes; staging validates them; serving
 * publishes them into the `arena.*` schema.
 *
 * NULL semantics: a null field means "this exchange doesn't expose it"
 * (spec §3) — the UI NULL-collapses, staging only rejects rows missing
 * fields listed in the source's required-field set.
 */

/** Canonical timeframes. 0 = "since inception" (Bitget bots, profile only). */
export type Timeframe = 0 | 7 | 30 | 90

/** Ranking timeframes — boards/rankings never use inception (spec §1.1-B). */
export type RankingTimeframe = 7 | 30 | 90

export const RANKING_TIMEFRAMES: readonly RankingTimeframe[] = [7, 30, 90]

export type ProductType = 'spot' | 'futures' | 'cfd' | 'onchain'
export type TraderKind = 'human' | 'bot'
export type BotStrategy = 'martingale' | 'grid' | 'ai'
export type Currency = 'USDT' | 'USDx' | 'USDC' | 'USD'
export type FetchRegion = 'local' | 'vps_sg' | 'vps_jp'
export type ServingMode = 'legacy' | 'shadow' | 'serving'
export type SourceStatus = 'active' | 'inactive' | 'blocked_pending_vps' | 'dropped'

/** Append-only history kinds (incremental cursor ingestion, spec §2.3). */
export type HistoryKind = 'position_history' | 'orders' | 'transfers' | 'copiers'

/** Tier-C lazy-fetch surfaces (spec §2.4). */
export type ProfileSurface =
  | 'profile'
  | 'positions'
  | 'position_history'
  | 'orders'
  | 'transfers'
  | 'copiers'

/** A row of arena.sources — the single source of per-source config. */
export interface SourceRow {
  id: number
  slug: string
  exchange_id: number
  product_type: ProductType
  trader_kind_scope: 'human' | 'bot' | 'mixed'
  adapter_slug: string
  leaderboard_url: string | null
  timeframes_native: number[]
  timeframes_derived: number[]
  tf_label_map: Record<string, number | null>
  expected_count: number | null
  deep_profile_topn: number
  positions_topn: number
  profile_cache_ttl: string
  copier_table_depth: 'full' | 'top10' | 'top3_preview' | 'none'
  currency: Currency
  page_size: number | null
  pagination_kind: 'numeric' | 'next_prev' | 'infinite_scroll' | 'api_cursor' | null
  cadence_tier_a: string
  cadence_tier_b: string
  cadence_tier_d: string
  fetch_region: FetchRegion
  rate_budget_ms: number
  phase: 0 | 1 | 2 | 3
  serving_mode: ServingMode
  status: SourceStatus
  meta: Record<string, unknown>
}

// ── Raw layer ──

/** One raw payload page as captured from the source (pre-parse). */
export interface RawPage {
  /** Page/cursor position for completeness assertions (spec §5.6). */
  pageIndex: number
  /** The raw JSON payload exactly as the endpoint returned it. */
  payload: unknown
  /** Endpoint URL the payload came from (provenance / debugging). */
  url: string
  fetchedAt: string
}

/** A bundle of raw payloads covering one logical surface (e.g. a profile). */
export interface RawBundle {
  pages: RawPage[]
  fetchedAt: string
}

/** Context handed to pure parsers — everything from the sources row that
 *  parsing needs. Parsers MUST be pure functions of (raw, ctx) so stored
 *  RAW payloads can always be re-parsed (spec §5.5). */
export interface ParseCtx {
  sourceSlug: string
  currency: Currency
  /** per-source label→canonical map, e.g. {"7D":7,"1M":30,"3M":90} */
  tfLabelMap: Record<string, number | null>
  scrapedAt: string
  meta: Record<string, unknown>
}

// ── Parsed (canonical) rows ──

export interface ParsedLeaderboardRow {
  exchangeTraderId: string
  rank: number
  nickname: string | null
  avatarUrlOrigin: string | null
  walletAddress: string | null
  traderKind: TraderKind
  botStrategy: BotStrategy | null
  headlineRoi: number | null
  headlinePnl: number | null
  headlineWinRate: number | null
  /** Durable per-trader routing facts merged into arena.traders.meta —
   *  e.g. Bitget UTA portfolio_id, which profile endpoints are keyed by.
   *  Distinct from `raw` (entry-scoped, never queried for fetch routing). */
  traderMeta?: Record<string, unknown> | null
  /** Board-card extras (sparkline, MDD, copier count, AUM, style tags...) —
   *  kept verbatim; never thrown away (spec §3 raw JSONB note). */
  raw: Record<string, unknown>
}

export interface ParsedLeaderboardPage {
  rows: ParsedLeaderboardRow[]
  /** Source-reported total where the endpoint exposes one. */
  reportedTotal: number | null
}

/** One point of a chart series. */
export interface SeriesPoint {
  ts: string
  value: number
}

/** Superset per-timeframe stats block (spec §3 trader_stats). */
export interface ParsedStats {
  timeframe: Timeframe
  asOf: string
  roi: number | null
  pnl: number | null
  sharpe: number | null
  mdd: number | null
  winRate: number | null
  winPositions: number | null
  totalPositions: number | null
  copierPnl: number | null
  copierCount: number | null
  aum: number | null
  volume: number | null
  profitShareRate: number | null
  /** Average holding duration in hours (stored as interval). */
  holdingDurationAvgHours: number | null
  tradingPreferences: Record<string, unknown> | null
  /** Style tags, risk rating, radar percentiles, NAV... (spec §12.2). */
  extras: Record<string, unknown>
}

/** metric names; _trading/_bot scope variants where the source splits them. */
export type SeriesMetric = string

/** One per-timeframe series block — shared by profile crawls (ParsedProfile)
 *  and the optional board-level "free series" (adapter.parseLeaderboardSeries). */
export interface BoardSeriesBlock {
  timeframe: Timeframe
  metric: SeriesMetric
  points: SeriesPoint[]
}

export interface ParsedProfile {
  stats: ParsedStats[]
  series: Array<{
    timeframe: Timeframe
    metric: SeriesMetric
    points: SeriesPoint[]
  }>
  /** Identity refresh fields seen on the profile page. */
  nickname: string | null
  avatarUrlOrigin: string | null
}

export interface ParsedPosition {
  symbol: string
  side: string | null
  leverage: number | null
  size: number | null
  entryPrice: number | null
  markPrice: number | null
  unrealizedPnl: number | null
  raw: Record<string, unknown>
}

export interface ParsedPositionHistoryRow {
  kind: 'position_history'
  openedAt: string | null
  closedAt: string | null
  symbol: string
  side: string | null
  leverage: number | null
  size: number | null
  entryPrice: number | null
  exitPrice: number | null
  realizedPnl: number | null
  /** Stable natural identity (source position id where available, else a
   *  deterministic field-tuple hash) — drives idempotent upserts. */
  dedupeHash: string
  raw: Record<string, unknown>
}

export interface ParsedOrderRow {
  kind: 'orders'
  ts: string
  orderKind: string | null
  symbol: string | null
  side: string | null
  price: number | null
  qty: number | null
  dedupeHash: string
  raw: Record<string, unknown>
}

export interface ParsedTransferRow {
  kind: 'transfers'
  ts: string
  direction: 'in' | 'out' | null
  asset: string | null
  amount: number | null
  dedupeHash: string
  raw: Record<string, unknown>
}

export interface ParsedCopierRow {
  kind: 'copiers'
  ts: string
  /** Stored for dedupe/aggregates only — NEVER rendered (spec §6 PII). */
  copierLabel: string | null
  copierPnl: number | null
  copierInvested: number | null
  copyDurationDays: number | null
  dedupeHash: string
  raw: Record<string, unknown>
}

export type ParsedHistoryRow =
  | ParsedPositionHistoryRow
  | ParsedOrderRow
  | ParsedTransferRow
  | ParsedCopierRow

// ── Capabilities ──

/** What surfaces a source actually exposes — drives Tier-B/C crawls and
 *  the frontend capability matrix (spec §6). */
export interface SurfaceCapabilities {
  profile: boolean
  positions: boolean
  positionHistory: boolean
  orders: boolean
  transfers: boolean
  copiers: boolean
}

// ── Helpers ──

/** Map a source TF label to canonical via the per-source map (spec §12.4).
 *  Returns null for labels we deliberately ignore (e.g. LBank 14D). */
export function mapTimeframeLabel(
  label: string,
  ctx: Pick<ParseCtx, 'tfLabelMap'>
): Timeframe | null {
  if (Object.prototype.hasOwnProperty.call(ctx.tfLabelMap, label)) {
    const v = ctx.tfLabelMap[label]
    return v === null ? null : (v as Timeframe)
  }
  // Default labels shared by most sources
  const defaults: Record<string, Timeframe> = {
    '7D': 7,
    '7d': 7,
    '30D': 30,
    '30d': 30,
    '90D': 90,
    '90d': 90,
  }
  return defaults[label] ?? null
}
