import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.coinex@1.
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

function pagedData(payload: unknown): { items: Dict[]; total: number | null } {
  const value = data(payload) as Dict | null
  const items = Array.isArray(value?.data) ? (value.data as Dict[]) : []
  return { items, total: int(value?.total) }
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseCoinexCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const { items } = pagedData(raw)
  const out: ParsedCopierRow[] = []

  for (const item of items) {
    if (item.follower_name === undefined || item.follower_name === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.follower_name),
      copierPnl: num(item.total_copy_earn_amount),
      copierInvested: num(item.fund_amount),
      copyDurationDays: null,
      dedupeHash: dedupeHash(
        'coinex_cp',
        item.follower_name,
        item.fund_amount,
        item.total_copy_earn_amount
      ),
      raw: item,
    })
  }

  return out
}
