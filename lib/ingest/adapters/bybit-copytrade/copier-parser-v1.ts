import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.bybit_copytrade@1.
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

function e(v: unknown, scale: number): number | null {
  const n = num(v)
  return n === null ? null : n / 10 ** scale
}

function result(payload: unknown): Dict {
  return ((payload as Dict)?.result ?? {}) as Dict
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBybitCopytradeCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const list = result(raw).data
  if (!Array.isArray(list)) return []

  const out: ParsedCopierRow[] = []
  for (const item of list as Dict[]) {
    const label = item.nickName
    if (typeof label !== 'string' || label === '') continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: e(item.cumYieldE8, 8),
      copierInvested: e(item.cumFollowCostE8, 8),
      copyDurationDays: int(item.cumFollowDays),
      dedupeHash: dedupeHash('bybitct_cp', label, item.cumFollowCostE8, item.cumFollowDays),
      raw: item,
    })
  }

  return out
}
