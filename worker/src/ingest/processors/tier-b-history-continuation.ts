/**
 * Tier-B backward continuation of page-cap-truncated orders/transfers history
 * (issue #440). Pure state transitions live in
 * lib/ingest/core/history-continuation.ts; this module owns the I/O:
 *
 *   read traders.meta.history_truncated[kind]
 *   → one bounded adapter run below the truncation point (same page budget)
 *   → RAW (always) → idempotent publish (ON CONFLICT dedupe, forward cursor
 *     untouched) → compare-and-set the marker (advance / clear / block).
 *
 * Every marker write is a compare-and-set against the exact marker that was
 * read, so a concurrent forward truncation (which re-arms the marker with a
 * newer boundary) is never overwritten or cleared by a stale continuation.
 */
import type { SourceAdapter } from '@/lib/ingest/core/adapter'
import {
  continuationRequest,
  effectiveContinuationState,
  evaluateContinuationRun,
  HISTORY_CONTINUATION_NOT_WIRED,
  initialContinuationState,
  oldestEventAt,
  parseTruncationMarker,
  type ContinuableHistoryKind,
  type ContinuationRunPage,
  type HistoryContinuationCapability,
  type HistoryContinuationState,
} from '@/lib/ingest/core/history-continuation'
import { HistoryPageCapReachedError } from '@/lib/ingest/core/history-page-cap'
import type { ParseCtx, ParsedHistoryRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import { getIngestPool } from '@/lib/ingest/db'
import { writeRawObject } from '@/lib/ingest/raw'
import { publishHistoryRows } from '@/lib/ingest/serving/publish'
import { logger } from '@/lib/utils/logger'

export function historyContinuationCapability(
  adapter: SourceAdapter,
  src: SourceRow,
  kind: ContinuableHistoryKind
): HistoryContinuationCapability {
  return adapter.historyContinuation?.(src, kind) ?? HISTORY_CONTINUATION_NOT_WIRED
}

/**
 * Durable truncation marker for orders/transfers history cut by a page budget
 * in a FORWARD run. traders.meta merges on every board publish
 * (`meta || EXCLUDED.meta`), so the marker survives. It always re-arms the
 * continuation from this newer cut: walking back from here to the source's
 * end also covers any older, still-pending gap (rows dedupe on insert).
 */
export async function recordHistoryTruncation(
  adapter: SourceAdapter,
  src: SourceRow,
  traderId: number,
  kind: ContinuableHistoryKind,
  cut: HistoryPageCapReachedError,
  rows: ParsedHistoryRow[]
): Promise<HistoryContinuationState> {
  const oldest = oldestEventAt(rows)
  const continuation = initialContinuationState(
    historyContinuationCapability(adapter, src, kind),
    oldest,
    cut.nextPage
  )
  await getIngestPool().query(
    `UPDATE arena.traders
        SET meta = meta || jsonb_build_object(
          'history_truncated',
          COALESCE(meta->'history_truncated', '{}'::jsonb) || jsonb_build_object(
            $2::text,
            jsonb_build_object(
              'detected_at', now(),
              'page_cap', $3::int,
              'oldest_captured_at', $4::text,
              'continuation', $5::jsonb
            )
          )
        )
      WHERE id = $1`,
    [traderId, kind, cut.pageCap, oldest, JSON.stringify(continuation)]
  )
  return continuation
}

async function readTruncationMarker(
  traderId: number,
  kind: ContinuableHistoryKind
): Promise<unknown> {
  const { rows } = await getIngestPool().query<{ marker: unknown }>(
    `SELECT meta->'history_truncated'->$2::text AS marker FROM arena.traders WHERE id = $1`,
    [traderId, kind]
  )
  return rows[0]?.marker ?? null
}

/** Compare-and-set the continuation inside the marker read as `expected`. */
async function casContinuation(
  traderId: number,
  kind: ContinuableHistoryKind,
  expected: unknown,
  next: HistoryContinuationState
): Promise<boolean> {
  const result = await getIngestPool().query(
    `UPDATE arena.traders
        SET meta = jsonb_set(meta, ARRAY['history_truncated', $2::text, 'continuation'], $4::jsonb)
      WHERE id = $1 AND meta->'history_truncated'->$2::text = $3::jsonb`,
    [traderId, kind, JSON.stringify(expected), JSON.stringify(next)]
  )
  return (result.rowCount ?? 0) > 0
}

/** Compare-and-clear the marker once the source reported no older data. */
async function casClearMarker(
  traderId: number,
  kind: ContinuableHistoryKind,
  expected: unknown
): Promise<boolean> {
  const result = await getIngestPool().query(
    `UPDATE arena.traders
        SET meta = CASE
          WHEN (meta #- ARRAY['history_truncated', $2::text])->'history_truncated' = '{}'::jsonb
            THEN meta - 'history_truncated'
          ELSE meta #- ARRAY['history_truncated', $2::text]
        END
      WHERE id = $1 AND meta->'history_truncated'->$2::text = $3::jsonb`,
    [traderId, kind, JSON.stringify(expected)]
  )
  return (result.rowCount ?? 0) > 0
}

export type HistoryContinuationOutcome =
  | 'no_marker'
  | 'invalid_marker'
  | 'unsupported'
  | 'blocked'
  | 'advanced'
  | 'completed'
  | 'rejected'
  | 'fetch_failed'
  | 'marker_changed'

export interface HistoryContinuationResult {
  outcome: HistoryContinuationOutcome
  rowsWritten: number
}

/**
 * One bounded backward continuation run for (trader, kind). Never throws for
 * an upstream failure: the forward history already committed, and the failure
 * is logged and stored on the marker (which stays set, so the gap remains
 * visible). DB errors propagate to the caller.
 */
export async function continueTruncatedHistory(
  session: FetchSession,
  adapter: SourceAdapter,
  src: SourceRow,
  trader: { id: number; exchange_trader_id: string; meta: Record<string, unknown> | null },
  kind: ContinuableHistoryKind,
  ctx: ParseCtx
): Promise<HistoryContinuationResult> {
  const label = `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} ${kind} continuation`
  const stored = await readTruncationMarker(trader.id, kind)
  if (stored === null) return { outcome: 'no_marker', rowsWritten: 0 }

  const parsed = parseTruncationMarker(stored)
  if (!parsed.ok) {
    // Fail closed: never guess a resume point from a marker we cannot read.
    logger.error(`${label}: stored truncation marker is invalid (${parsed.reason}); skipped`)
    return { outcome: 'invalid_marker', rowsWritten: 0 }
  }

  const capability = historyContinuationCapability(adapter, src, kind)
  const state = effectiveContinuationState(parsed.marker, capability)
  if (!capability.supported) {
    const recorded = parsed.marker.continuation
    if (recorded?.state !== 'unsupported' || recorded.reason !== capability.reason) {
      // Record the limitation explicitly instead of pretending to continue.
      await casContinuation(trader.id, kind, stored, {
        state: 'unsupported',
        reason: capability.reason,
      })
    }
    return { outcome: 'unsupported', rowsWritten: 0 }
  }
  if (state.state !== 'pending') {
    return { outcome: state.state === 'unsupported' ? 'unsupported' : 'blocked', rowsWritten: 0 }
  }
  if (state.mode !== capability.mode) {
    logger.error(
      `${label}: stored mode ${state.mode} no longer matches adapter mode ${capability.mode}; blocked`
    )
    await casContinuation(trader.id, kind, stored, {
      state: 'blocked',
      reason: 'mode_mismatch',
      boundary_at: state.boundary_at,
    })
    return { outcome: 'blocked', rowsWritten: 0 }
  }

  const request = continuationRequest(state)
  const rawPages: RawPage[] = []
  let fetchError: unknown = null
  try {
    for await (const page of adapter.getHistory(
      session,
      src,
      trader.exchange_trader_id,
      kind,
      null,
      trader.meta,
      { continuation: request }
    )) {
      rawPages.push(page)
    }
  } catch (error) {
    fetchError = error
  }
  const cut = fetchError instanceof HistoryPageCapReachedError ? fetchError : null
  const failed = fetchError !== null && cut === null

  // RAW first, always — including failed runs (diagnostics).
  if (rawPages.length > 0 || fetchError !== null) {
    await writeRawObject({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: `history:${kind}`,
      traderId: trader.id,
      timeframe: null,
      payload: rawPages,
      meta: {
        continuation: true,
        continuation_request: request,
        fetch_failed: failed,
        caller_limited: cut !== null,
        ...(cut !== null ? { page_cap: cut.pageCap } : {}),
      },
    })
  }

  if (failed) {
    const message = fetchError instanceof Error ? fetchError.message : String(fetchError)
    logger.error(`${label}: upstream fetch failed (marker kept, retried next run): ${message}`)
    await casContinuation(trader.id, kind, stored, {
      ...state,
      runs: state.runs + 1,
      last_error: message.slice(0, 500),
    })
    return { outcome: 'fetch_failed', rowsWritten: 0 }
  }

  const pages: ContinuationRunPage[] = rawPages.map((page) => ({
    pageIndex: page.pageIndex,
    rows: adapter.parseHistory(page.payload, kind, ctx),
  }))
  const decision = evaluateContinuationRun(state, request, {
    pages,
    capReached: cut !== null ? { nextPage: cut.nextPage } : null,
    pageCap: cut?.pageCap ?? parsed.marker.page_cap,
  })

  if (decision.action === 'reject') {
    logger.error(`${label}: run rejected (${decision.reason}); nothing published`)
    const ok = await casContinuation(trader.id, kind, stored, decision.next)
    return { outcome: ok ? 'rejected' : 'marker_changed', rowsWritten: 0 }
  }

  const rows = pages.flatMap((page) => page.rows)
  // newCursor null: the forward incremental cursor only ever moves forward
  // and is owned by the forward crawl; inserts dedupe on (ts, dedupe_hash).
  const rowsWritten =
    rows.length > 0 ? await publishHistoryRows(src, trader.id, kind, rows, null) : 0

  if (decision.action === 'publish_and_clear') {
    const cleared = await casClearMarker(trader.id, kind, stored)
    if (!cleared) {
      logger.warn(`${label}: source exhausted but marker changed concurrently; left in place`)
      return { outcome: 'marker_changed', rowsWritten }
    }
    logger.info(`${label}: reached the source's oldest record; truncation marker cleared`)
    return { outcome: 'completed', rowsWritten }
  }

  const advanced = await casContinuation(trader.id, kind, stored, decision.next)
  if (!advanced) {
    logger.warn(`${label}: marker changed concurrently; progress not stored (rows kept)`)
    return { outcome: 'marker_changed', rowsWritten }
  }
  if (decision.next.state === 'blocked') {
    logger.error(`${label}: blocked (${decision.next.reason})`)
    return { outcome: 'blocked', rowsWritten }
  }
  logger.info(
    `${label}: advanced to ${decision.next.state === 'pending' ? decision.next.boundary_at : '?'} ` +
      `(${rowsWritten} new rows)`
  )
  return { outcome: 'advanced', rowsWritten }
}
