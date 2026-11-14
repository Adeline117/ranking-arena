/**
 * Backward continuation of page-cap-truncated orders/transfers history
 * (issue #440).
 *
 * A Tier-B forward crawl streams newest→older pages and stops at its page
 * budget. When the budget runs out before a short page / cursor overlap, the
 * adapter throws HistoryPageCapReachedError and the processor records
 * `traders.meta.history_truncated[kind]`. This module defines the durable
 * continuation state stored inside that marker and the pure transitions that
 * let later runs walk further back — one bounded page budget per run — until
 * the source reports no older data, at which point the marker is cleared.
 *
 * Storage: the continuation lives inside the existing
 * `traders.meta.history_truncated[kind]` object, so no migration is needed.
 * The forward cursor in `arena.ingest_cursors` is never touched by a
 * continuation run (it only ever moves forward).
 *
 * Fail-closed rules:
 *  - page_offset: offset pages drift as new rows arrive newest-first, so a
 *    continuation resumes ONE page before the stored resume page and must
 *    prove overlap (a row at or after the stored boundary) on its first page.
 *    Without overlap a deletion may have shifted rows past the resume point;
 *    the run publishes nothing and steps back instead of risking a silent gap.
 *  - end_time: the request bounds the window by event time; any returned row
 *    newer than that bound means the source ignored the window, so nothing is
 *    published and the continuation is blocked.
 *  - Sources whose API cannot page further back record an explicit
 *    `unsupported` state with a reason instead of pretending.
 */
import type { HistoryKind, ParsedHistoryRow } from './types'

export type ContinuableHistoryKind = Extract<HistoryKind, 'orders' | 'transfers'>

export const CONTINUABLE_HISTORY_KINDS: readonly ContinuableHistoryKind[] = ['orders', 'transfers']

export function isContinuableHistoryKind(kind: HistoryKind): kind is ContinuableHistoryKind {
  return kind === 'orders' || kind === 'transfers'
}

/**
 * page_offset: numeric newest-first pages; resume by page number.
 * end_time:    the source accepts an inclusive/exclusive upper event-time
 *              bound; resume strictly below the oldest captured event.
 */
export type HistoryContinuationMode = 'page_offset' | 'end_time'

export type HistoryContinuationCapability =
  | { supported: true; mode: HistoryContinuationMode }
  | { supported: false; reason: string }

/** Capability for adapters that do not declare one. */
export const HISTORY_CONTINUATION_NOT_WIRED: HistoryContinuationCapability = {
  supported: false,
  reason: 'adapter_not_wired',
}

export type HistoryContinuationRequest =
  | { mode: 'page_offset'; startPage: number }
  | { mode: 'end_time'; endTimeMs: number }

/** Optional 7th argument of SourceAdapter.getHistory. */
export interface HistoryFetchOptions {
  /** Present only on a backward continuation run; the cursor is then null. */
  continuation?: HistoryContinuationRequest
}

export type HistoryContinuationState =
  | {
      state: 'pending'
      mode: 'page_offset'
      /** First page NOT yet captured by the previous (forward or backward) run. */
      resume_page: number
      /** Oldest event time proven captured so far. */
      boundary_at: string
      runs: number
      last_error: string | null
    }
  | {
      state: 'pending'
      mode: 'end_time'
      boundary_at: string
      runs: number
      last_error: string | null
    }
  | { state: 'unsupported'; reason: string }
  | { state: 'blocked'; reason: string; boundary_at: string | null }

export interface HistoryTruncationMarker {
  detected_at: string
  page_cap: number
  oldest_captured_at: string | null
  continuation?: HistoryContinuationState
}

function eventAt(row: ParsedHistoryRow): string | null {
  return row.kind === 'position_history' ? row.closedAt : row.ts
}

function eventMs(row: ParsedHistoryRow): number | null {
  const value = eventAt(row)
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Oldest parseable event time among rows, as canonical ISO, or null. */
export function oldestEventAt(rows: readonly ParsedHistoryRow[]): string | null {
  let oldest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const ms = eventMs(row)
    if (ms !== null && ms < oldest) oldest = ms
  }
  return Number.isFinite(oldest) ? new Date(oldest).toISOString() : null
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** State recorded by a forward run that just hit its page cap. */
export function initialContinuationState(
  capability: HistoryContinuationCapability,
  oldestCapturedAt: string | null,
  nextPage: number | undefined
): HistoryContinuationState {
  if (!capability.supported) return { state: 'unsupported', reason: capability.reason }
  if (oldestCapturedAt === null || !isIsoTimestamp(oldestCapturedAt)) {
    return { state: 'blocked', reason: 'no_event_timestamp', boundary_at: null }
  }
  if (capability.mode === 'end_time') {
    return {
      state: 'pending',
      mode: 'end_time',
      boundary_at: oldestCapturedAt,
      runs: 0,
      last_error: null,
    }
  }
  if (!isPositiveInt(nextPage) || nextPage < 2) {
    return {
      state: 'blocked',
      reason: 'resume_page_not_reported',
      boundary_at: oldestCapturedAt,
    }
  }
  return {
    state: 'pending',
    mode: 'page_offset',
    resume_page: nextPage,
    boundary_at: oldestCapturedAt,
    runs: 0,
    last_error: null,
  }
}

export type ParsedTruncationMarker =
  | { ok: true; marker: HistoryTruncationMarker }
  | { ok: false; reason: string }

function parseContinuationState(value: unknown): HistoryContinuationState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.state === 'unsupported' && typeof v.reason === 'string') {
    return { state: 'unsupported', reason: v.reason }
  }
  if (v.state === 'blocked' && typeof v.reason === 'string') {
    return {
      state: 'blocked',
      reason: v.reason,
      boundary_at: isIsoTimestamp(v.boundary_at) ? v.boundary_at : null,
    }
  }
  if (v.state !== 'pending' || !isIsoTimestamp(v.boundary_at)) return null
  const runs =
    typeof v.runs === 'number' && Number.isSafeInteger(v.runs) && v.runs >= 0 ? v.runs : 0
  const lastError = typeof v.last_error === 'string' ? v.last_error : null
  if (v.mode === 'end_time') {
    return {
      state: 'pending',
      mode: 'end_time',
      boundary_at: v.boundary_at,
      runs,
      last_error: lastError,
    }
  }
  if (v.mode === 'page_offset' && isPositiveInt(v.resume_page) && v.resume_page >= 2) {
    return {
      state: 'pending',
      mode: 'page_offset',
      resume_page: v.resume_page,
      boundary_at: v.boundary_at,
      runs,
      last_error: lastError,
    }
  }
  return null
}

/** Validate a stored `history_truncated[kind]` value. Malformed → not ok. */
export function parseTruncationMarker(value: unknown): ParsedTruncationMarker {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'marker_not_object' }
  }
  const v = value as Record<string, unknown>
  if (!isPositiveInt(v.page_cap)) return { ok: false, reason: 'marker_page_cap_invalid' }
  const oldest =
    v.oldest_captured_at === null || v.oldest_captured_at === undefined
      ? null
      : isIsoTimestamp(v.oldest_captured_at)
        ? v.oldest_captured_at
        : undefined
  if (oldest === undefined) return { ok: false, reason: 'marker_oldest_invalid' }
  const marker: HistoryTruncationMarker = {
    detected_at: typeof v.detected_at === 'string' ? v.detected_at : '',
    page_cap: v.page_cap,
    oldest_captured_at: oldest,
  }
  if (v.continuation !== undefined) {
    const continuation = parseContinuationState(v.continuation)
    if (continuation === null) return { ok: false, reason: 'marker_continuation_invalid' }
    marker.continuation = continuation
  }
  return { ok: true, marker }
}

/**
 * Effective continuation state of a marker. Markers written before #440 carry
 * no continuation: the forward crawl that produced them always started at
 * page 1, so the first uncaptured page is page_cap + 1.
 */
export function effectiveContinuationState(
  marker: HistoryTruncationMarker,
  capability: HistoryContinuationCapability
): HistoryContinuationState {
  if (marker.continuation !== undefined) return marker.continuation
  return initialContinuationState(capability, marker.oldest_captured_at, marker.page_cap + 1)
}

export function continuationRequest(
  state: Extract<HistoryContinuationState, { state: 'pending' }>
): HistoryContinuationRequest {
  if (state.mode === 'page_offset') {
    // One page of deliberate overlap: newest-first offsets only drift towards
    // higher page numbers as new rows arrive, so the page before the resume
    // point still contains the boundary or newer rows.
    return { mode: 'page_offset', startPage: Math.max(1, state.resume_page - 1) }
  }
  // +1 ms: correct whether the source treats endTime as inclusive or
  // exclusive; rows at the boundary millisecond are re-fetched and deduped.
  return { mode: 'end_time', endTimeMs: Date.parse(state.boundary_at) + 1 }
}

export interface ContinuationRunPage {
  pageIndex: number
  rows: readonly ParsedHistoryRow[]
}

export interface ContinuationRunOutcome {
  pages: readonly ContinuationRunPage[]
  /** Set when the run itself stopped at its page budget. */
  capReached: { nextPage: number | undefined } | null
  pageCap: number
}

export type ContinuationDecision =
  /** Source reached its end: publish the rows and clear the marker. */
  | { action: 'publish_and_clear' }
  /** Publish the rows and store the advanced continuation state. */
  | { action: 'publish_and_advance'; next: HistoryContinuationState }
  /** Publish nothing (RAW only) and store the new state. */
  | { action: 'reject'; next: HistoryContinuationState; reason: string }

/** Pure decision for one bounded continuation run. */
export function evaluateContinuationRun(
  state: Extract<HistoryContinuationState, { state: 'pending' }>,
  request: HistoryContinuationRequest,
  outcome: ContinuationRunOutcome
): ContinuationDecision {
  const boundaryMs = Date.parse(state.boundary_at)
  const allRows = outcome.pages.flatMap((page) => page.rows)
  const runs = state.runs + 1

  if (state.mode === 'page_offset' && request.mode === 'page_offset') {
    const first = outcome.pages[0]
    if (first === undefined) {
      if (request.startPage === 1 && outcome.capReached === null) {
        // The source now has no rows at all: nothing older can exist.
        return { action: 'publish_and_clear' }
      }
    }
    const overlap =
      first !== undefined &&
      first.pageIndex === request.startPage &&
      first.rows.some((row) => {
        const ms = eventMs(row)
        return ms !== null && ms >= boundaryMs
      })
    if (!overlap) {
      if (request.startPage <= 1) {
        const next: HistoryContinuationState = {
          state: 'blocked',
          reason: 'overlap_not_proven',
          boundary_at: state.boundary_at,
        }
        return { action: 'reject', next, reason: 'overlap_not_proven' }
      }
      // Rows were likely removed upstream and shifted older pages forward:
      // step back one budget and prove overlap again on the next run.
      const next: HistoryContinuationState = {
        ...state,
        resume_page: Math.max(2, state.resume_page - outcome.pageCap),
        runs,
        last_error: 'overlap_not_proven',
      }
      return { action: 'reject', next, reason: 'overlap_not_proven' }
    }
    if (outcome.capReached === null) return { action: 'publish_and_clear' }
    const nextPage = outcome.capReached.nextPage
    if (!isPositiveInt(nextPage) || nextPage <= request.startPage) {
      return {
        action: 'reject',
        next: {
          state: 'blocked',
          reason: 'resume_page_not_reported',
          boundary_at: state.boundary_at,
        },
        reason: 'resume_page_not_reported',
      }
    }
    const oldest = oldestEventAt(allRows)
    const boundaryAt =
      oldest !== null && Date.parse(oldest) < boundaryMs ? oldest : state.boundary_at
    return {
      action: 'publish_and_advance',
      next: { ...state, resume_page: nextPage, boundary_at: boundaryAt, runs, last_error: null },
    }
  }

  if (state.mode === 'end_time' && request.mode === 'end_time') {
    const newer = allRows.some((row) => {
      const ms = eventMs(row)
      return ms !== null && ms > request.endTimeMs
    })
    if (newer) {
      return {
        action: 'reject',
        next: { state: 'blocked', reason: 'window_not_honored', boundary_at: state.boundary_at },
        reason: 'window_not_honored',
      }
    }
    if (outcome.capReached === null) return { action: 'publish_and_clear' }
    const oldest = oldestEventAt(allRows)
    if (oldest === null || Date.parse(oldest) >= boundaryMs) {
      // A full budget of rows at the boundary millisecond (or none at all):
      // an end-time cursor cannot move past it. Publish the genuine rows but
      // stop retrying an identical request every run.
      return {
        action: 'publish_and_advance',
        next: { state: 'blocked', reason: 'no_progress', boundary_at: state.boundary_at },
      }
    }
    return {
      action: 'publish_and_advance',
      next: { ...state, boundary_at: oldest, runs, last_error: null },
    }
  }

  return {
    action: 'reject',
    next: { state: 'blocked', reason: 'mode_mismatch', boundary_at: state.boundary_at },
    reason: 'mode_mismatch',
  }
}
