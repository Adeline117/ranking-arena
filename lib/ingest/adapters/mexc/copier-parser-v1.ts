import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.mexc@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function data(payload: unknown): Dict | null {
  const value = (payload as Dict)?.data
  return value && typeof value === 'object' ? (value as Dict) : null
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseMexcCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const payload = data(raw)
  const list = Array.isArray(payload?.content) ? (payload.content as Dict[]) : []
  const out: ParsedCopierRow[] = []

  for (const item of list) {
    const uid = item.followerUid
    if (!uid) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String((item.nickname as string) ?? uid),
      copierPnl: num(item.copyProfit),
      copierInvested: num(item.copyFunds),
      copyDurationDays: null,
      dedupeHash: dedupeHash('mexc_cp', uid, item.copyFunds, item.copyProfit),
      raw: item,
    })
  }

  return out
}
