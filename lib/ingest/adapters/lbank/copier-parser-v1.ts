import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.lbank@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

function pagedRecords(payload: unknown): { records: Dict[]; total: number | null } {
  const value = data(payload) as Dict | null
  const records = Array.isArray(value?.records) ? (value.records as Dict[]) : []
  return { records, total: int(value?.total) }
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseLbankCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const { records } = pagedRecords(raw)
  const out: ParsedCopierRow[] = []

  for (const item of records) {
    if (item.name === undefined || item.name === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.name),
      copierPnl: num(item.totalProfit),
      copierInvested: null,
      copyDurationDays: int(item.followDays),
      dedupeHash: dedupeHash('lbank_cp', item.name, item.followDays, item.totalProfit),
      raw: item,
    })
  }

  return out
}
