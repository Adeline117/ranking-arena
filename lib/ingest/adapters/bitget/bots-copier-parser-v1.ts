import { createHash } from 'crypto'

import type { ParseCtx, ParsedCopierRow } from '../../core/types'

/**
 * Append-only implementation for arena.ingest.copier-parser.bitget_bots@1.
 * Never change this module after the contract is published; add a new version instead.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function isoFromMs(v: unknown): string | null {
  const n = num(v)
  return n === null ? null : new Date(n).toISOString()
}

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

export function parseBitgetBotsCopiersV1(raw: unknown, ctx: ParseCtx): ParsedCopierRow[] {
  const data = ((raw as Dict)?.data ?? null) as Dict | null
  const followers = Array.isArray(data?.followers) ? (data.followers as Dict[]) : []
  const ts = isoFromMs(data?.lastUpdateTime) ?? ctx.scrapedAt

  const out: ParsedCopierRow[] = []
  for (const follower of followers) {
    const label = (follower.followerUserName ?? follower.followerUserDisplayName) as
      | string
      | undefined
    if (!label) continue
    const durationMs = num(follower.followerTime)
    out.push({
      kind: 'copiers',
      ts,
      copierLabel: String(label),
      copierPnl: num(follower.followerProfitAmount),
      copierInvested: num(follower.followerInvestmentAmount),
      copyDurationDays: durationMs === null ? null : Math.round(durationMs / 86_400_000),
      dedupeHash: dedupeHash(
        'bitget_bot_cp',
        label,
        follower.followerProfitAmount,
        follower.followerInvestmentAmount
      ),
      raw: follower,
    })
  }

  return out
}
