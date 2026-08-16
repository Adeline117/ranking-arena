import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.blofin@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function dataRows(raw: unknown): Dict[] {
  const data = (raw as Dict)?.data
  return Array.isArray(data) ? (data as Dict[]) : []
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBlofinCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const out: ParsedCopierRow[] = []

  for (const copier of dataRows(raw)) {
    const label = typeof copier.nick_name === 'string' ? copier.nick_name : null
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(copier.return_amount),
      copierInvested: num(copier.cum_invested ?? copier.amount),
      copyDurationDays: int(copier.follower_days),
      dedupeHash: dedupeHash('blofin_cp', copier.id ?? label, copier.follow_time),
      raw: copier,
    })
  }

  return out
}
