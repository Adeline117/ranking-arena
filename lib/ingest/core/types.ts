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
  /**
   * Endpoint provenance URL. Evidence-preserving captures store a public,
   * credential-free projection; legacy adapters may still store the actual
   * URL and must not be treated as sanitized until migrated.
   */
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

export type ParsedRankingMetric = 'roi' | 'pnl' | 'win_rate' | 'mdd' | 'sharpe'

/**
 * Parser-owned claim about where one value was read. Deliberately contains
 * only the upstream field path: provenance, units, methodology, completeness,
 * and rank eligibility come from Arena's reviewed registry and acquisition
 * evidence, never from an adapter or payload.
 */
export interface ParsedMetricFieldSource {
  fieldPath: string
  /**
   * Framework-owned 1-based ordinal of the captured source page containing
   * this exact metric value. Adapters must not self-assert it; the Tier-A
   * processor strips adapter input and binds the ordinal from capture
   * evidence after parsing.
   */
  sourcePageOrdinal?: number
}

export type ParsedHeadlineMetricSources = Partial<
  Record<ParsedRankingMetric, ParsedMetricFieldSource>
>

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
  /** Present only when the canonical value is directly attributable to one
   *  exact upstream field (including a registry-owned unit conversion such as
   *  fraction→percent). Staging mutations remove the claim. Missing means the
   *  publisher has no field lineage and must keep that metric unrankable. */
  headlineMetricSources?: ParsedHeadlineMetricSources
  /** Board-level stat columns for PROFILE-LESS sources whose board IS the
   *  stats substrate (e.g. blofin: no per-uid profile endpoint, but the board
   *  carries mdd/sharpe/aum/followers). Populate ONLY when the board is the
   *  authoritative source — the publish headline upsert writes these with
   *  COALESCE(EXCLUDED, existing) so leaving them null/undefined never clobbers
   *  a richer profile crawl on sources that have one. (spec §0 "单段榜→主页回填"
   *  inverse: for profile-less sources the board backfills the stats.) */
  headlineMdd?: number | null
  headlineSharpe?: number | null
  headlineAum?: number | null
  headlineCopierCount?: number | null
  /** Board-level copier PnL — many boards carry a real copier/follower PnL per
   *  row (binance/bybit/bitget), previously captured only for deep-crawled
   *  profiles (~17% fill). */
  headlineCopierPnl?: number | null
  /** Board-level average holding time in HOURS (phemex/bybit expose it). */
  headlineHoldingDurationHours?: number | null
  headlineVolume?: number | null
  headlineWinPositions?: number | null
  headlineTotalPositions?: number | null
  /** Board-derived extras for profile-less sources (bingx rankStat superset:
   *  avg_profit / trades_per_week / trading_days / last_trade_time …). Merged
   *  into trader_stats.extras by the publish headline upsert (board keys win,
   *  existing profile extras preserved). Null/omitted → extras untouched. */
  headlineExtras?: Record<string, unknown> | null
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
  /**
   * This non-empty block is the complete upstream snapshot for its series
   * key. The board publisher may therefore replace old daily and weekly
   * points atomically before inserting it. Omitted means append/upsert.
   */
  replaceSeries?: boolean
}

export interface ParsedProfile {
  stats: ParsedStats[]
  series: Array<{
    timeframe: Timeframe
    metric: SeriesMetric
    points: SeriesPoint[]
  }>
  /**
   * Series keys for which this profile is a complete replacement snapshot.
   * The publisher deletes old daily/weekly points for these keys inside the
   * same transaction before inserting `series`; omitted means append/upsert.
   */
  replaceSeries?: Array<{
    timeframe: Timeframe
    metrics: SeriesMetric[]
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

/** Typed arena.trader_stats metric keys an adapter can emit (board headline
 *  and/or profile stats). snake_case = the DB column names. */
export type ExpectedMetric =
  | 'roi'
  | 'pnl'
  | 'sharpe'
  | 'mdd'
  | 'win_rate'
  | 'win_positions'
  | 'total_positions'
  | 'copier_pnl'
  | 'copier_count'
  | 'aum'
  | 'volume'
  | 'profit_share_rate'
  | 'holding_duration_avg'

/**
 * Declarative "should-have" metric contract (2026-07-04, P0 of the data-
 * completeness system). The exchange PROVIDES these metrics (per the
 * screenshot-calibrated 交易所细节.docx audit) and the adapter's parsers are
 * expected to emit them. This is deliberately INDEPENDENT of ingested data —
 * arena.mv_source_capabilities derives its metric list from trader_stats
 * counts, which measures "have", never "should have", so a parser that
 * silently drops a field (the 2026-07-03 gate-sharpe class) looks fine to it.
 * Enforced two ways:
 *   1. expected-metrics-parity test: every declared metric must be emitted
 *      non-null by the adapter's parsers over its own RAW fixtures (CI gate).
 *   2. fill-rate sentinel: declared metrics must have non-zero fill in prod
 *      (arena.sources.meta.expected_metrics, synced by the worker reconcile).
 */
export type ExpectedMetrics = readonly ExpectedMetric[]

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
