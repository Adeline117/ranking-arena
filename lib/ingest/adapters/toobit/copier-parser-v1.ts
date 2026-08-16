import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.toobit@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === '****' || v === '--') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v !== '****' && v !== '--' ? v : null
}

function objects(v: unknown): Dict[] {
  return Array.isArray(v)
    ? (v as unknown[]).filter(
        (row): row is Dict => typeof row === 'object' && row !== null && !Array.isArray(row)
      )
    : []
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseToobitCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const list = objects(((raw ?? {}) as { data?: unknown }).data)
  const out: ParsedCopierRow[] = []

  for (const item of list) {
    const label = str(item.followerNickname)
    if (!label) continue
    const runningMs = num(item.followRunningMills)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(item.totalFollowProfit),
      copierInvested: num(item.totalFollowAmount),
      copyDurationDays: runningMs !== null ? Math.floor(runningMs / 86_400_000) : null,
      dedupeHash: dedupeHash('toobit_cp', label, item.followRunningMills),
      raw: item,
    })
  }

  return out
}
