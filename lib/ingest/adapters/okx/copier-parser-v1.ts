import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.okx@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim().length === 0) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function dataRows(block: unknown): Dict[] {
  const value = (block ?? {}) as { data?: unknown }
  return Array.isArray(value.data) ? (value.data as Dict[]) : []
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseOkxCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const block = dataRows(raw)[0]
  if (!block) return []
  const list = Array.isArray(block.copyTraders) ? (block.copyTraders as Dict[]) : []
  const scrapedMs = Date.parse(ctx.scrapedAt)
  const out: ParsedCopierRow[] = []

  for (const item of list) {
    const label = str(item.nickName)
    if (!label) continue
    const begin = num(item.beginCopyTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(item.pnl),
      copierInvested: null,
      copyDurationDays:
        begin !== null && Number.isFinite(scrapedMs) && scrapedMs > begin
          ? Math.floor((scrapedMs - begin) / 86_400_000)
          : null,
      dedupeHash: dedupeHash('okx_cp', label, item.beginCopyTime),
      // Keep the exact candidate; aggregate block fields are capture-level evidence.
      raw: item,
    })
  }

  return out
}
