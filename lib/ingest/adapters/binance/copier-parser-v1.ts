import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.binance@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

interface BinanceCopierHistoryEnvelopeV1 {
  portfolioId?: unknown
  response?: unknown
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim().length === 0) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function listOf(payload: unknown): Dict[] {
  const data = (payload as Dict)?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const list = (data as Dict).list
  return Array.isArray(list) ? (list as Dict[]) : []
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBinanceCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const wrapper = (raw ?? {}) as BinanceCopierHistoryEnvelopeV1
  const portfolioId = String(wrapper.portfolioId ?? '')
  const scrapedMs = Date.parse(ctx.scrapedAt)
  const out: ParsedCopierRow[] = []

  for (const item of listOf(wrapper.response)) {
    const label = item.copyPortfolioId ?? item.nickname
    if (!label) continue
    const started = num(item.createTime ?? item.startTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(label),
      copierPnl: num(item.totalPnl),
      copierInvested: num(item.marginBalance ?? item.balanceAmount),
      copyDurationDays:
        started !== null && Number.isFinite(scrapedMs)
          ? Math.max(0, Math.floor((scrapedMs - started) / 86_400_000))
          : null,
      dedupeHash: dedupeHash('binance_cp', portfolioId, label, started),
      raw: item,
    })
  }

  return out
}
