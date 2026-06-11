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

export interface SourceAdapter {
  /** Matches arena.sources.adapter_slug. */
  readonly slug: string
  readonly capabilities: SurfaceCapabilities

  /** Tier A: stream leaderboard pages for one timeframe. */
  listLeaderboard(
    session: FetchSession,
    src: SourceRow,
    timeframe: RankingTimeframe
  ): AsyncIterable<RawPage>

  /** Tier B/C: the main profile surface (stats blocks + charts) for one TF.
   *  Must be a small number of replayed JSON requests (spec §2.4: 1-3s). */
  getProfile(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    timeframe: Timeframe
  ): Promise<RawBundle>

  /** Tier D: current open positions (snapshot semantics). */
  getPositions(session: FetchSession, src: SourceRow, exchangeTraderId: string): Promise<RawBundle>

  /** Append-only histories: yield newest→older pages; the caller stops
   *  consuming once rows overlap the stored cursor (spec §2.3). */
  getHistory(
    session: FetchSession,
    src: SourceRow,
    exchangeTraderId: string,
    kind: HistoryKind,
    cursor: string | null
  ): AsyncIterable<RawPage>

  // ── Pure parsers ──
  parseLeaderboard(raw: unknown, ctx: ParseCtx): ParsedLeaderboardPage
  parseProfile(raw: unknown, ctx: ParseCtx): ParsedProfile
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
