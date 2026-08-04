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
  HistoryEvidenceState,
  HistoryScanTerminalState,
  RecordKind,
  RecordProvenance,
  RecordsPage,
  ServingCurrency,
} from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])
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
const VERIFIED_POSITION_HISTORY_COMPLETENESS_CONTRACT =
  'arena.position-history-completeness@2' as const
const SOURCE_RUN_SHA256 = /^[0-9a-f]{64}$/

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  )
}

function isHistoryRecordKind(kind: Exclude<RecordKind, 'copiers'>): boolean {
  return kind === 'position_history'
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
  // RAW is an internal audit substrate, never a serving field.
  'raw',
  // Parser-conservation claims identify upstream rows and field paths. They
  // are publication evidence, not part of the public record contract.
  'sourceFactId',
  'source_fact_id',
  'sourceLifecycleMarker',
  'source_lifecycle_marker',
  'fieldSources',
  'field_sources',
  'limitations',
  // `sourceReturn` / `source_return` are intentionally not stripped: the
  // verified @2 projection exposes that economic value alongside normalized
  // ROI, while the claim-only identity/path fields above remain internal.
  // Never assign prototype-affecting keys from an untrusted payload.
  '__proto__',
  'prototype',
  'constructor',
])

export function sanitizeRecordRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!BANNED_ROW_KEYS.has(key)) out[key] = value
  }
  return out
}

function sanitizeRecordRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const rows: Record<string, unknown>[] = []
  for (const candidate of value) {
    if (isPlainRecord(candidate)) rows.push(sanitizeRecordRow(candidate))
  }
  return rows
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeSafeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function unknownHistoryCompleteness(): HistoryCompleteness {
  return { state: 'unknown', reason: 'history_evidence_not_bound' }
}

const VERIFIED_COMPLETENESS_KEYS = [
  'blockerReasons',
  'contract',
  'evidenceState',
  'publicationId',
  'reason',
  'scanTerminalState',
  'state',
] as const

/**
 * A warm page becomes complete only when the read RPC binds its verdict to one
 * immutable verified publication. Rows/counts alone are not evidence: an old
 * or drifted RPC response remains explicitly unknown.
 */
function verifiedPositionHistoryCompleteness(
  payload: Record<string, unknown>
): HistoryCompleteness | null {
  const completeness = payload.completeness
  if (!isPlainRecord(completeness) || !hasExactKeys(completeness, VERIFIED_COMPLETENESS_KEYS)) {
    return null
  }

  const publicationId = nonNegativeSafeIntegerOrNull(payload.publicationId)
  const stateId = nonNegativeSafeIntegerOrNull(payload.stateId)
  const verdictPublicationId = nonNegativeSafeIntegerOrNull(completeness.publicationId)
  if (
    publicationId === null ||
    publicationId === 0 ||
    stateId !== publicationId ||
    verdictPublicationId !== publicationId ||
    completeness.contract !== VERIFIED_POSITION_HISTORY_COMPLETENESS_CONTRACT ||
    completeness.state !== 'complete' ||
    completeness.reason !== 'verified_terminal_history' ||
    completeness.evidenceState !== 'verified' ||
    (completeness.scanTerminalState !== 'exhausted' &&
      completeness.scanTerminalState !== 'cursor_overlap') ||
    !Array.isArray(completeness.blockerReasons) ||
    completeness.blockerReasons.length !== 0 ||
    typeof payload.sourceRunId !== 'string' ||
    !SOURCE_RUN_SHA256.test(payload.sourceRunId) ||
    payload.sourceRunId === '0'.repeat(64) ||
    validTimestampOrNull(payload.observedAt) === null ||
    validTimestampOrNull(payload.publishedAt) === null
  ) {
    return null
  }

  return {
    state: 'complete',
    reason: 'verified_terminal_history',
    evidenceState: 'verified',
    scanTerminalState: completeness.scanTerminalState,
    blockerReasons: [],
  }
}

function opaqueCursorOrNull(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    value === value.trim()
    ? value
    : null
}

/**
 * Tier-C is an explicitly bounded preview. Parse diagnostics only from that
 * exact state; a payload can never upgrade itself to complete or unknown.
 */
function parseInteractivePreviewDiagnostics(value: unknown): Partial<HistoryCompleteness> | null {
  if (!isPlainRecord(value)) return null
  if (value.state !== 'partial' || value.reason !== 'interactive_preview') return null

  const diagnosticKeys = ['evidenceState', 'scanTerminalState', 'blockerReasons'] as const
  const presentKeys = diagnosticKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
  if (presentKeys.length === 0) return {}
  if (presentKeys.length !== diagnosticKeys.length) return null
  if (
    typeof value.evidenceState !== 'string' ||
    !HISTORY_EVIDENCE_STATES.has(value.evidenceState as HistoryEvidenceState) ||
    typeof value.scanTerminalState !== 'string' ||
    !HISTORY_SCAN_TERMINAL_STATES.has(value.scanTerminalState as HistoryScanTerminalState) ||
    !Array.isArray(value.blockerReasons) ||
    value.blockerReasons.length > HISTORY_BLOCKER_REASONS.size ||
    new Set(value.blockerReasons).size !== value.blockerReasons.length ||
    !value.blockerReasons.every(
      (reason) =>
        typeof reason === 'string' &&
        HISTORY_BLOCKER_REASONS.has(reason as HistoryCompletenessBlockerReason)
    )
  ) {
    return null
  }

  const evidenceState = value.evidenceState as HistoryEvidenceState
  const scanTerminalState = value.scanTerminalState as HistoryScanTerminalState
  const blockerReasons = value.blockerReasons as HistoryCompletenessBlockerReason[]
  const expected: Record<
    HistoryEvidenceState,
    { scans: HistoryScanTerminalState[]; blockers: HistoryCompletenessBlockerReason[] }
  > = {
    verified: { scans: ['exhausted', 'cursor_overlap'], blockers: [] },
    missing: { scans: ['unknown'], blockers: ['terminal_claim_missing'] },
    invalid: { scans: ['unknown'], blockers: ['terminal_claim_invalid'] },
    verifier_missing: { scans: ['unknown'], blockers: ['terminal_verifier_missing'] },
    rejected: { scans: ['unknown'], blockers: ['terminal_claim_rejected'] },
    caller_limited: { scans: ['partial'], blockers: ['caller_limit'] },
    upstream_error: { scans: ['partial'], blockers: ['upstream_error'] },
  }
  const expectedDiagnostics = expected[evidenceState]
  if (
    !expectedDiagnostics.scans.includes(scanTerminalState) ||
    blockerReasons.length !== expectedDiagnostics.blockers.length ||
    blockerReasons.some((blocker, index) => blocker !== expectedDiagnostics.blockers[index])
  ) {
    return null
  }

  return { evidenceState, scanTerminalState, blockerReasons }
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
  if (error || !isPlainRecord(data)) return null
  const d = data
  const verifiedCompleteness =
    kind === 'position_history' ? verifiedPositionHistoryCompleteness(d) : null
  const quarantineUnverifiedHistory = kind === 'position_history' && verifiedCompleteness === null
  return {
    // A legacy/drifted RPC may still return typed rows and a legacy cursor.
    // Neither is public truth unless this exact response carries the @2
    // publication binding validated above.
    rows: quarantineUnverifiedHistory ? [] : sanitizeRecordRows(d.rows),
    nextCursor: quarantineUnverifiedHistory ? null : opaqueCursorOrNull(d.nextCursor),
    provenance: recordProvenance(source, d),
    cacheState: 'warm',
    ...(kind === 'position_history'
      ? { completeness: verifiedCompleteness ?? unknownHistoryCompleteness() }
      : {}),
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
  if (error || !isPlainRecord(data)) return null
  const d = data

  const distribution: CopierAggregate['pnlDistribution'] = []
  if (Array.isArray(d.pnlDistribution)) {
    for (const candidate of d.pnlDistribution) {
      if (!isPlainRecord(candidate)) continue
      const count = nonNegativeSafeIntegerOrNull(candidate.count)
      if (typeof candidate.bucket === 'string' && count !== null) {
        distribution.push({ bucket: candidate.bucket, count })
      }
    }
  }

  const totalPnl = finiteNumberOrNull(d.totalCopierPnl)
  const depth =
    d.depth === 'full' || d.depth === 'top10' || d.depth === 'top3_preview' ? d.depth : 'none'

  return {
    copierCount: nonNegativeSafeIntegerOrNull(d.copierCount),
    copierCountMax: nonNegativeSafeIntegerOrNull(d.copierCountMax),
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
  payload: unknown
): RecordsPage | null {
  if (!isPlainRecord(payload) || !Array.isArray(payload.rows)) return null
  const historyPreview = isHistoryRecordKind(kind)
  const diagnostics = historyPreview
    ? parseInteractivePreviewDiagnostics(payload.completeness)
    : null
  return {
    rows: sanitizeRecordRows(payload.rows),
    // A bounded preview is not a durable page and must never advertise an
    // upstream or legacy cursor supplied by an old/malformed worker.
    nextCursor: historyPreview
      ? null
      : typeof payload.nextCursor === 'string'
        ? payload.nextCursor
        : null,
    provenance: recordProvenance(source, payload),
    cacheState: 'cold-fetched',
    ...(historyPreview
      ? {
          completeness: {
            state: 'partial' as const,
            reason: 'interactive_preview' as const,
            ...(diagnostics ?? {}),
          },
        }
      : {}),
  }
}
