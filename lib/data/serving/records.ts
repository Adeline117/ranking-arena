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
import type { CopierAggregate, RecordKind, RecordsPage, ServingCurrency } from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC'])

function asCurrency(v: unknown): ServingCurrency {
  return typeof v === 'string' && CURRENCIES.has(v) ? (v as ServingCurrency) : 'USDT'
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
  if (error || !data) return null
  const d = data as Record<string, unknown>
  const rows = Array.isArray(d.rows) ? (d.rows as Record<string, unknown>[]) : []
  return {
    rows: rows.map(sanitizeRecordRow),
    nextCursor: typeof d.nextCursor === 'string' ? d.nextCursor : null,
    provenance: {
      source,
      asOf: typeof d.asOf === 'string' ? d.asOf : new Date().toISOString(),
    },
    cacheState: 'warm',
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
    provenance: {
      source,
      asOf: typeof d.asOf === 'string' ? d.asOf : new Date().toISOString(),
    },
  }
}

/** Map a Tier-C record-surface result payload into a RecordsPage. */
export function recordsPageFromTierC(
  source: string,
  payload: Record<string, unknown>
): RecordsPage | null {
  const rows = Array.isArray(payload.rows) ? (payload.rows as Record<string, unknown>[]) : null
  if (!rows) return null
  return {
    rows: rows.map(sanitizeRecordRow),
    nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
    provenance: {
      source,
      asOf: typeof payload.asOf === 'string' ? payload.asOf : new Date().toISOString(),
    },
    cacheState: 'cold-fetched',
  }
}
