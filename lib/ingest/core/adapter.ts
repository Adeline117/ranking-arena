/**
 * SourceAdapter — the single interface every source implements (spec §2.1).
 *
 * One adapter may serve several arena.sources rows (e.g. the `bitget`
 * adapter serves bitget_futures/spot/cfd via src.meta.boardKey). Adapters
 * contain ALL site-specific quirks; nothing site-specific leaks into the
 * framework.
 *
 * Fetch methods receive a FetchSession (Playwright/HTTP, rate-budgeted,
 * UTC-pinned) and return RAW payloads. Parse methods are PURE functions of
 * (raw, ctx) so any stored RAW object can be re-parsed (spec §5.5) — they
 * must never touch the network, the clock, or module state.
 */

import type {
  BoardSeriesBlock,
  ExpectedMetrics,
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedPosition,
  ParsedProfile,
  RankingTimeframe,
  RawBundle,
  RawPage,
  SourceRow,
  SurfaceCapabilities,
  Timeframe,
} from './types'
import type { FetchSession } from '../fetch/types'
import type { ProfileQualityReject } from './profile-quality'

/** Lets expensive adapters defer deep enrichment off interactive/series paths. */
export type ProfileFetchIntent = 'scheduled_full' | 'series_only' | 'interactive_deferred'

export interface ProfileFetchOptions {
  intent: ProfileFetchIntent
}

export interface SourceAdapter {
  /** Matches arena.sources.adapter_slug. */
  readonly slug: string
  readonly capabilities: SurfaceCapabilities
  /**
   * Optional source-row refinement for adapters shared by more than one
   * product. The static capability remains the adapter-wide upper bound;
   * returning false here declares that a specific source cannot expose the
   * surface (for example, OKX's public position APIs are SWAP-only even
   * though the same adapter also serves its SPOT leaderboard).
   */
  supportsSurface?(src: SourceRow, surface: keyof SurfaceCapabilities): boolean
  /** Declarative "should-have" metric contract (see ExpectedMetrics in
   *  types.ts): metrics the exchange provides and our parsers must emit.
   *  Locked by the expected-metrics-parity test + the fill-rate sentinel.
   *  Optional during rollout — the parity test flags undeclared adapters. */
  readonly expectedMetrics?: ExpectedMetrics

  /** Tier A: stream leaderboard pages for one timeframe. */
  listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage>

  /** Tier B/C: the main profile surface (stats blocks + charts) for one TF.
   *  Must be a small number of replayed JSON requests (spec §2.4: 1-3s).
   *  `traderMeta` = arena.traders.meta — adapters that route profile calls
   *  by an id other than exchange_trader_id (e.g. Bitget UTA portfolio_id)
   *  read it from here; omitting it degrades gracefully. */
  getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe,
    traderMeta: Record<string, unknown> | null | undefined,
    options: ProfileFetchOptions
  ): Promise<RawBundle>

  /** Tier D: current open positions (snapshot semantics). */
  getPositions(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    traderMeta?: Record<string, unknown> | null
  ): Promise<RawBundle>

  /** Append-only histories: yield newest→older pages; the caller stops
   *  consuming once rows overlap the stored cursor (spec §2.3). */
  getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null,
    traderMeta?: Record<string, unknown> | null
  ): AsyncIterable<RawPage>

  // ── Pure parsers ──
  parseLeaderboard(raw: unknown, ctx: ParseCtx): ParsedLeaderboardPage
  parseProfile(raw: unknown, ctx: ParseCtx): ParsedProfile
  /** Optional source-specific whole-profile quality gate. Processors invoke
   *  it only after RAW is durable and before any serving/cache publication. */
  validateProfile?(
    profile: ParsedProfile,
    ctx: ParseCtx,
    requestedTimeframe: Timeframe,
    raw: unknown
  ): ProfileQualityReject[]

  /**
   * OPTIONAL board-level series (spec §13.1 "free series"). Some boards embed
   * a per-trader cumulative ROI/PnL sparkline IN the leaderboard row (okx
   * pnlRatios, toobit leaderTradeProfit, xt chart, blofin chart_data.roi,
   * bitunix dailyWinRate/dailyPl, binance_web3 dailyPNL). Decoding it costs
   * ZERO extra fetches —
   * the array already rides in row.raw from the Tier-A crawl. When present,
   * EVERY ranked trader (not just topN) gets a chart for free, closing the
   * long-tail coverage gap that otherwise waits on Tier-B/C profile fetches.
   *
   * Returns exchangeTraderId → series blocks for the given board TF. Adapters
   * whose board has no inline series simply omit this method. PURE — same
   * (raw, ctx) re-parse contract as the other parsers.
   */
  parseLeaderboardSeries?(
    raw: unknown,
    ctx: ParseCtx,
    timeframe: RankingTimeframe
  ): Map<string, BoardSeriesBlock[]>
  parsePositions(raw: unknown, ctx: ParseCtx): ParsedPosition[]
  parseHistory(raw: unknown, kind: HistoryKind, ctx: ParseCtx): ParsedHistoryRow[]
}

// ── Registry ──

const registry = new Map<string, SourceAdapter>()

export function registerAdapter(adapter: SourceAdapter): void {
  if (registry.has(adapter.slug)) {
    throw new Error(`[ingest] adapter already registered: ${adapter.slug}`)
  }
  registry.set(adapter.slug, adapter)
}

export function getAdapter(slug: string): SourceAdapter {
  const adapter = registry.get(slug)
  if (!adapter) {
    throw new Error(
      `[ingest] no adapter registered for slug "${slug}" — ` +
        `did you import its module in the worker bootstrap?`
    )
  }
  return adapter
}

export function listAdapters(): string[] {
  return [...registry.keys()]
}
