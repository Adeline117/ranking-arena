import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.btcc@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rows(payload: unknown): Dict[] {
  const value = (payload as Dict)?.rows
  return Array.isArray(value) ? (value as Dict[]) : []
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBtccCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const scraped = Date.parse(ctx.scrapedAt)
  const out: ParsedCopierRow[] = []

  for (const item of rows(raw)) {
    if (item.userId === undefined || item.userId === null) continue
    const followMs = num(item.followTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String((item.nickName as string) || item.userId),
      copierPnl: num(item.cumulativeNetProfit),
      copierInvested: null,
      copyDurationDays:
        followMs !== null && followMs > 0 && Number.isFinite(scraped)
          ? Math.max(0, Math.floor((scraped - followMs) / 86_400_000))
          : null,
      dedupeHash: dedupeHash('btcc_cp', item.userId, item.followTime),
      raw: item,
    })
  }

  return out
}
