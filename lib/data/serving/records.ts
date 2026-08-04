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

function ownValue(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

function currencyOrNull(value: unknown): ServingCurrency | null {
  return typeof value === 'string' && CURRENCIES.has(value) ? (value as ServingCurrency) : null
}

function recordTimestampOrNull(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    !/T.*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)
  ) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

/**
 * Exact public row decoder for both RPC and Redis boundaries. This is an
 * allowlist, not a blacklist: unknown fields, RAW, natural identities, claim
 * evidence, and copier attributes cannot escape when an upstream contract
 * grows or drifts. Camel-case aliases only bridge short-lived Tier-C caches
 * from workers deployed before the canonical snake-case writer.
 */
export function sanitizeRecordRow(
  kind: Exclude<RecordKind, 'copiers'>,
  row: Record<string, unknown>
): Record<string, unknown> | null {
  if (kind === 'positions') {
    const symbol = stringOrNull(ownValue(row, 'symbol'))
    if (symbol === null) return null
    return {
      symbol,
      side: stringOrNull(ownValue(row, 'side')),
      margin_mode: stringOrNull(ownValue(row, 'margin_mode', 'marginMode')),
      leverage: finiteNumberOrNull(ownValue(row, 'leverage')),
      size: finiteNumberOrNull(ownValue(row, 'size')),
      entry_price: finiteNumberOrNull(ownValue(row, 'entry_price', 'entryPrice')),
      mark_price: finiteNumberOrNull(ownValue(row, 'mark_price', 'markPrice')),
      notional: finiteNumberOrNull(ownValue(row, 'notional')),
      margin: finiteNumberOrNull(ownValue(row, 'margin')),
      unrealized_pnl: finiteNumberOrNull(ownValue(row, 'unrealized_pnl', 'unrealizedPnl')),
      roe: finiteNumberOrNull(ownValue(row, 'roe')),
      currency: currencyOrNull(ownValue(row, 'currency')),
      as_of: recordTimestampOrNull(ownValue(row, 'as_of', 'asOf')),
    }
  }

  if (kind === 'position_history') {
    const symbol = stringOrNull(ownValue(row, 'symbol'))
    if (symbol === null) return null
    return {
      symbol,
      side: stringOrNull(ownValue(row, 'side')),
      margin_mode: stringOrNull(ownValue(row, 'margin_mode', 'marginMode')),
      leverage: finiteNumberOrNull(ownValue(row, 'leverage')),
      size: finiteNumberOrNull(ownValue(row, 'size')),
      entry_price: finiteNumberOrNull(ownValue(row, 'entry_price', 'entryPrice')),
      exit_price: finiteNumberOrNull(ownValue(row, 'exit_price', 'exitPrice')),
      max_open_interest: finiteNumberOrNull(ownValue(row, 'max_open_interest', 'maxOpenInterest')),
      realized_pnl: finiteNumberOrNull(ownValue(row, 'realized_pnl', 'realizedPnl')),
      roi: finiteNumberOrNull(ownValue(row, 'roi')),
      closing_value: finiteNumberOrNull(ownValue(row, 'closing_value', 'closingValue')),
      opened_at: recordTimestampOrNull(ownValue(row, 'opened_at', 'openedAt')),
      closed_at: recordTimestampOrNull(ownValue(row, 'closed_at', 'closedAt')),
      currency: currencyOrNull(ownValue(row, 'currency')),
    }
  }

  if (kind === 'orders') {
    const timestamp = recordTimestampOrNull(ownValue(row, 'ts'))
    if (timestamp === null) return null
    const orderKind = stringOrNull(ownValue(row, 'order_kind', 'orderKind', 'kind'))
    return {
      ts: timestamp,
      kind: orderKind === 'orders' ? null : orderKind,
      symbol: stringOrNull(ownValue(row, 'symbol')),
      side: stringOrNull(ownValue(row, 'side')),
      price: finiteNumberOrNull(ownValue(row, 'price')),
      qty: finiteNumberOrNull(ownValue(row, 'qty')),
      notional: finiteNumberOrNull(ownValue(row, 'notional')),
      realized_pnl: finiteNumberOrNull(ownValue(row, 'realized_pnl', 'realizedPnl')),
      currency: currencyOrNull(ownValue(row, 'currency')),
    }
  }

  const timestamp = recordTimestampOrNull(ownValue(row, 'ts'))
  if (timestamp === null) return null
  const direction = ownValue(row, 'direction')
  return {
    ts: timestamp,
    direction: direction === 'in' || direction === 'out' ? direction : null,
    asset: stringOrNull(ownValue(row, 'asset')),
    amount: finiteNumberOrNull(ownValue(row, 'amount')),
  }
}

function sanitizeRecordRows(
  kind: Exclude<RecordKind, 'copiers'>,
  value: unknown
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const rows: Record<string, unknown>[] = []
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) continue
    const row = sanitizeRecordRow(kind, candidate)
    if (row !== null) rows.push(row)
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

function isAppendOnlyHistory(kind: Exclude<RecordKind, 'copiers'>): boolean {
  return kind !== 'positions'
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
  if (error || !isPlainRecord(data)) return null
  const d = data
  // `arena_records_page` still projects legacy typed position-history rows.
  // Those rows are not bound to the parser-conservation receipt contract, so
  // neither their contents nor their pagination boundary can be served as warm
  // truth. Keep the observation clocks for cold-cache routing, but fail closed
  // until the RPC is replaced by a receipt-bound projection.
  const mayServeRows = kind !== 'position_history'
  const isHistory = isAppendOnlyHistory(kind)
  return {
    rows: mayServeRows ? sanitizeRecordRows(kind, d.rows) : [],
    nextCursor: mayServeRows && typeof d.nextCursor === 'string' ? d.nextCursor : null,
    provenance: recordProvenance(source, d),
    cacheState: 'warm',
    ...(isHistory ? { completeness: unknownHistoryCompleteness() } : {}),
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
  const currency = currencyOrNull(d.currency)
  const depth =
    d.depth === 'full' || d.depth === 'top10' || d.depth === 'top3_preview' ? d.depth : 'none'

  const aggregate: CopierAggregate = {
    copierCount: nonNegativeSafeIntegerOrNull(d.copierCount),
    copierCountMax: nonNegativeSafeIntegerOrNull(d.copierCountMax),
    totalCopierPnl: totalPnl === null || currency === null ? null : money(totalPnl, currency),
    // Bucket labels/thresholds share the aggregate's money unit. Without a
    // validated unit they are not safe to interpret either.
    pnlDistribution: currency === null ? [] : distribution,
    depth,
    provenance: recordProvenance(source, d),
    // `depth=full` describes the upstream product surface, not proof that the
    // aggregate is bound to a terminal collection receipt.
    completeness: unknownHistoryCompleteness(),
  }

  // Some RPC branches return a syntactically valid all-null object when no
  // stats or private copier rows exist. That shell is not evidence and must
  // not be cached as a warm aggregate. `depth=none` is the one exception: it
  // is an explicit source-level N/A declaration, so no collector should run.
  if (
    aggregate.depth !== 'none' &&
    aggregate.copierCount === null &&
    aggregate.copierCountMax === null &&
    aggregate.totalCopierPnl === null &&
    aggregate.pnlDistribution.length === 0
  ) {
    return null
  }

  return aggregate
}

/** Map a Tier-C record-surface result payload into a RecordsPage. */
export function recordsPageFromTierC(
  source: string,
  kind: Exclude<RecordKind, 'copiers'>,
  payload: unknown
): RecordsPage | null {
  if (!isPlainRecord(payload) || !Array.isArray(payload.rows)) return null
  const rows = sanitizeRecordRows(kind, payload.rows)
  const parsedCompleteness = parseHistoryCompleteness(payload.completeness)
  const isHistory = isAppendOnlyHistory(kind)
  const previewCompleteness: HistoryCompleteness | undefined = isHistory
    ? {
        state: 'partial',
        reason: 'interactive_preview',
        ...(parsedCompleteness?.evidenceState && parsedCompleteness.evidenceState !== 'verified'
          ? { evidenceState: parsedCompleteness.evidenceState }
          : {}),
        ...(parsedCompleteness?.scanTerminalState === 'partial' ||
        parsedCompleteness?.scanTerminalState === 'unknown'
          ? { scanTerminalState: parsedCompleteness.scanTerminalState }
          : {}),
        ...(parsedCompleteness?.blockerReasons?.length
          ? { blockerReasons: parsedCompleteness.blockerReasons }
          : {}),
      }
    : undefined
  return {
    rows,
    // Tier-C append-only history is a bounded preview and may never advertise
    // pagination, even if an old or malformed worker payload supplies a cursor.
    nextCursor: isHistory
      ? null
      : typeof payload.nextCursor === 'string'
        ? payload.nextCursor
        : null,
    provenance: recordProvenance(source, payload),
    cacheState: 'cold-fetched',
    ...(previewCompleteness ? { completeness: previewCompleteness } : {}),
  }
}
