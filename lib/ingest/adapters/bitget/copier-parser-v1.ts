import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.bitget@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

const BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT_V1 = 'arena.ingest.bitget-history-page@1' as const

function unwrapHistoryPage(raw: unknown): unknown {
  return (raw as Dict)?.contract === BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT_V1
    ? (raw as Dict).response
    : raw
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim().length === 0) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBitgetCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const response = unwrapHistoryPage(raw)
  const rows = ((response as Dict)?.data as Dict)?.rows
  if (!Array.isArray(rows)) return []

  const out: ParsedCopierRow[] = []
  for (const item of rows as Dict[]) {
    const label = (item.userName ?? item.displayName ?? item.followerNickName) as string | undefined
    if (!label) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(label),
      copierPnl: num(item.totalProfit),
      copierInvested: num(item.totalMargin),
      copyDurationDays: null,
      dedupeHash: dedupeHash('bitget_cp', label, item.totalProfit, item.totalMargin),
      raw: item,
    })
  }

  return out
}
