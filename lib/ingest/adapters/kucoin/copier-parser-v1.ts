import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.kucoin@1.
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

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

function pagedItems(payload: unknown): { items: Dict[]; total: number | null } {
  const value = data(payload) as Dict | null
  const items = Array.isArray(value?.items) ? (value.items as Dict[]) : []
  return { items, total: int(value?.totalNum) }
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseKucoinCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const { items } = pagedItems(raw)
  const out: ParsedCopierRow[] = []

  for (const item of items) {
    if (item.nickName === undefined || item.nickName === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.nickName),
      copierPnl: num(item.pnl),
      copierInvested: num(item.copyPrincipal),
      copyDurationDays: int(item.copyDays),
      dedupeHash: dedupeHash('kucoin_cp', item.nickName, item.copyPrincipal, item.copyDays),
      raw: item,
    })
  }

  return out
}
