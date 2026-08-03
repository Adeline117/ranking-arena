/**
 * Heavy-tab record pages (spec §2.4-3) + copier aggregate (spec §6).
 *
 * Warm reads come from the keyset-paginated arena_records_page RPC; the
 * copiers kind is aggregate-only — the SQL raises on row access and never
 * selects copier_label. The serializers here strip identifier-ish keys
 * again as defense in depth (route tests assert it).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { money } from '@/lib/utils/money'
import { logRpcError } from './log-rpc-error'
import type {
  CopierAggregate,
  HistoryCompleteness,
  HistoryCompletenessBlockerReason,
  HistoryCompletenessReason,
  HistoryEvidenceState,
  HistoryScanTerminalState,
  RecordKind,
  RecordProvenance,
  RecordsPage,
  ServingCurrency,
} from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

const HISTORY_COMPLETENESS_REASONS: ReadonlySet<HistoryCompletenessReason> = new Set([
  'verified_terminal_history',
  'interactive_preview',
  'history_evidence_not_bound',
])
const HISTORY_EVIDENCE_STATES: ReadonlySet<HistoryEvidenceState> = new Set([
  'verified',
  'missing',
  'invalid',
  'verifier_missing',
  'rejected',
  'caller_limited',
  'upstream_error',
])
const HISTORY_SCAN_TERMINAL_STATES: ReadonlySet<HistoryScanTerminalState> = new Set([
  'exhausted',
  'cursor_overlap',
  'partial',
  'unknown',
])
const HISTORY_BLOCKER_REASONS: ReadonlySet<HistoryCompletenessBlockerReason> = new Set([
  'terminal_claim_missing',
  'terminal_claim_invalid',
  'terminal_verifier_missing',
  'terminal_claim_rejected',
  'caller_limit',
  'upstream_error',
])

function asCurrency(v: unknown): ServingCurrency {
  return typeof v === 'string' && CURRENCIES.has(v) ? (v as ServingCurrency) : 'USDT'
}

function validTimestampOrNull(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    Number.isFinite(Date.parse(value))
    ? value
    : null
}

function recordProvenance(source: string, payload: Record<string, unknown>): RecordProvenance {
  return {
    source,
    sourceAsOf: validTimestampOrNull(payload.sourceAsOf),
    observedAt: validTimestampOrNull(payload.observedAt),
    publishedAt: validTimestampOrNull(payload.publishedAt),
  }
}

/** Copier-PII guard (spec §6): these keys never leave the API layer. */
const BANNED_ROW_KEYS: ReadonlySet<string> = new Set([
  'copier_label',
  'copierLabel',
  'copier_name',
  'copierName',
  'email',
  'user_id',
  'userId',
])

export function sanitizeRecordRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!BANNED_ROW_KEYS.has(key)) out[key] = value
  }
  return out
}

function unknownHistoryCompleteness(): HistoryCompleteness {
  return { state: 'unknown', reason: 'history_evidence_not_bound' }
}

/** Parse trust metadata at the RPC/Redis boundary and reject contradictory
 * `complete` claims. This prevents an unverified payload from opening a rank
 * or UI trust gate merely by setting state=complete. */
function parseHistoryCompleteness(value: unknown): HistoryCompleteness | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.state !== 'complete' &&
    candidate.state !== 'partial' &&
    candidate.state !== 'unknown'
  ) {
    return null
  }
  if (
    typeof candidate.reason !== 'string' ||
    !HISTORY_COMPLETENESS_REASONS.has(candidate.reason as HistoryCompletenessReason)
  ) {
    return null
  }
  if (
    (candidate.state === 'partial' && candidate.reason !== 'interactive_preview') ||
    (candidate.state === 'unknown' && candidate.reason !== 'history_evidence_not_bound')
  ) {
    return null
  }

  const evidenceState =
    typeof candidate.evidenceState === 'string' &&
    HISTORY_EVIDENCE_STATES.has(candidate.evidenceState as HistoryEvidenceState)
      ? (candidate.evidenceState as HistoryEvidenceState)
      : undefined
  const scanTerminalState =
    typeof candidate.scanTerminalState === 'string' &&
    HISTORY_SCAN_TERMINAL_STATES.has(candidate.scanTerminalState as HistoryScanTerminalState)
      ? (candidate.scanTerminalState as HistoryScanTerminalState)
      : undefined
  const blockerReasons = Array.isArray(candidate.blockerReasons)
    ? candidate.blockerReasons.every(
        (reason) =>
          typeof reason === 'string' &&
          HISTORY_BLOCKER_REASONS.has(reason as HistoryCompletenessBlockerReason)
      )
      ? (candidate.blockerReasons as HistoryCompletenessBlockerReason[])
      : null
    : undefined
  if (blockerReasons === null) return null

  if (
    candidate.state === 'complete' &&
    (candidate.reason !== 'verified_terminal_history' ||
      evidenceState !== 'verified' ||
      (scanTerminalState !== 'exhausted' && scanTerminalState !== 'cursor_overlap') ||
      (blockerReasons?.length ?? 0) > 0)
  ) {
    return null
  }

  return {
    state: candidate.state,
    reason: candidate.reason as HistoryCompletenessReason,
    ...(evidenceState ? { evidenceState } : {}),
    ...(scanTerminalState ? { scanTerminalState } : {}),
    ...(blockerReasons ? { blockerReasons } : {}),
  }
}

export async function getRecordsPage(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string,
  kind: Exclude<RecordKind, 'copiers'>,
  cursor: string | null,
  limit = 50
): Promise<RecordsPage | null> {
  const { data, error } = await supabase.rpc('arena_records_page', {
    p_source: source,
    p_trader: exchangeTraderId,
    p_kind: kind,
    p_tf: null,
    p_cursor: cursor,
    p_limit: limit,
  })
  logRpcError('arena_records_page', error)
  if (error || !data) return null
  const d = data as Record<string, unknown>
  const rows = Array.isArray(d.rows) ? (d.rows as Record<string, unknown>[]) : []
  return {
    rows: rows.map(sanitizeRecordRow),
    nextCursor: typeof d.nextCursor === 'string' ? d.nextCursor : null,
    provenance: recordProvenance(source, d),
    cacheState: 'warm',
    ...(kind === 'position_history' ? { completeness: unknownHistoryCompleteness() } : {}),
  }
}

export async function getCopierAggregate(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string
): Promise<CopierAggregate | null> {
  const { data, error } = await supabase.rpc('arena_copier_aggregate', {
    p_source: source,
    p_trader: exchangeTraderId,
  })
  logRpcError('arena_copier_aggregate', error)
  if (error || !data) return null
  const d = data as Record<string, unknown>

  const distribution: CopierAggregate['pnlDistribution'] = []
  if (Array.isArray(d.pnlDistribution)) {
    for (const b of d.pnlDistribution as Array<Record<string, unknown>>) {
      if (typeof b.bucket === 'string' && typeof b.count === 'number') {
        distribution.push({ bucket: b.bucket, count: b.count })
      }
    }
  }

  const totalPnl = typeof d.totalCopierPnl === 'number' ? d.totalCopierPnl : null
  const depth =
    d.depth === 'full' || d.depth === 'top10' || d.depth === 'top3_preview' ? d.depth : 'none'

  return {
    copierCount: typeof d.copierCount === 'number' ? d.copierCount : null,
    copierCountMax: typeof d.copierCountMax === 'number' ? d.copierCountMax : null,
    totalCopierPnl: totalPnl === null ? null : money(totalPnl, asCurrency(d.currency)),
    pnlDistribution: distribution,
    depth,
    provenance: recordProvenance(source, d),
  }
}

/** Map a Tier-C record-surface result payload into a RecordsPage. */
export function recordsPageFromTierC(
  source: string,
  kind: Exclude<RecordKind, 'copiers'>,
  payload: Record<string, unknown>
): RecordsPage | null {
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : null
  if (!rows) return null
  const parsedCompleteness = parseHistoryCompleteness(payload.completeness)
  const previewCompleteness: HistoryCompleteness | undefined =
    kind === 'position_history'
      ? {
          state: 'partial',
          reason: 'interactive_preview',
          ...(parsedCompleteness?.evidenceState
            ? { evidenceState: parsedCompleteness.evidenceState }
            : {}),
          ...(parsedCompleteness?.scanTerminalState
            ? { scanTerminalState: parsedCompleteness.scanTerminalState }
            : {}),
          ...(parsedCompleteness?.blockerReasons
            ? { blockerReasons: parsedCompleteness.blockerReasons }
            : {}),
        }
      : undefined
  return {
    rows: rows.map(sanitizeRecordRow),
    // Tier-C history is a bounded preview and may never advertise pagination,
    // even if an old or malformed worker payload supplies a cursor.
    nextCursor:
      kind === 'position_history'
        ? null
        : typeof payload.nextCursor === 'string'
          ? payload.nextCursor
          : null,
    provenance: recordProvenance(source, payload),
    cacheState: 'cold-fetched',
    ...(previewCompleteness ? { completeness: previewCompleteness } : {}),
  }
}
