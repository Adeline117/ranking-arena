import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.gate@1.
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

function isoSecs(v: unknown): string | null {
  const n = num(v)
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString()
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseGateCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const data = (raw as Dict)?.data
  const rows = Array.isArray(data) ? (data as Dict[]) : ((data as Dict)?.list as Dict[])
  if (!Array.isArray(rows)) return []

  const out: ParsedCopierRow[] = []
  for (const item of rows) {
    if (item.follow_id !== undefined) {
      out.push({
        kind: 'copiers',
        ts: isoSecs(item.create_time) ?? ctx.scrapedAt,
        copierLabel: String(item.follow_id),
        copierPnl: num(item.profit),
        copierInvested: num(item.follow_money),
        copyDurationDays: null,
        dedupeHash: dedupeHash('gate_cp', item.follow_id, item.create_time),
        raw: item,
      })
    } else if (item.nick_name !== undefined) {
      out.push({
        kind: 'copiers',
        ts: ctx.scrapedAt,
        copierLabel: String(item.nick_name),
        copierPnl: num(item.total_profit),
        copierInvested: num(item.total_follow_amount),
        copyDurationDays: int(item.total_follow_day),
        dedupeHash: dedupeHash(
          'gate_cfd_cp',
          item.nick_name,
          item.total_follow_amount,
          item.total_profit
        ),
        raw: item,
      })
    }
  }

  return out
}
