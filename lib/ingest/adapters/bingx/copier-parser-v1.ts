import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.bingx@1.
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

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBingxCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const list = ((raw as Dict)?.data as Dict | undefined)?.followerDetailsVoList
  const rows = Array.isArray(list) ? (list as Dict[]) : []
  const out: ParsedCopierRow[] = []

  for (const copier of rows) {
    const label = typeof copier.nickName === 'string' ? copier.nickName : null
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(copier.followingProfitLoss),
      copierInvested: num(copier.copyAmount),
      copyDurationDays: int(copier.followingDays),
      dedupeHash: dedupeHash('bingx_cp', label, copier.copyAmount),
      raw: copier,
    })
  }

  return out
}
