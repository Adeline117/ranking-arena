import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.xt@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

function num(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') {
    n = v
  } else if (typeof v === 'string') {
    const normalized = v.trim()
    if (!DECIMAL_NUMBER.test(normalized)) return null
    n = Number(normalized)
  } else {
    return null
  }
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

export function parseXtCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const rows = ((raw as Dict)?.result as Dict | undefined)?.items
  const list = Array.isArray(rows) ? (rows as Dict[]) : []
  const out: ParsedCopierRow[] = []

  for (const item of list) {
    const label = typeof item.followerName === 'string' ? item.followerName : null
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(item.followProfitU),
      copierInvested: num(item.followMarginU ?? item.followAmountTotal),
      copyDurationDays: int(item.days),
      dedupeHash: dedupeHash('xt_cp', item.id ?? label),
      raw: item,
    })
  }

  return out
}
