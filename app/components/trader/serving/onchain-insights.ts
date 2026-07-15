/**
 * Pure shapers for the §2.5d on-chain insight blocks (token distribution / top
 * earning tokens / PnL calendar). Kept separate from the component so the
 * extras→view-model mapping is unit-testable. Every shaper NULL-collapses:
 * returns null when the source extras don't carry that block.
 */

import { readStoredOnchainQuality, type StoredOnchainQuality } from '@/lib/onchain-quality'

export interface TokenDistBucket {
  /** stable key for i18n labelling in the component */
  key: 'gt_500' | 'p0_500' | 'n50_0' | 'lt_n50'
  count: number
  positive: boolean
}

export type TokenDistributionUnit = 'pnl_percent' | 'realized_pnl_usd'

export interface TokenDistribution {
  unit: TokenDistributionUnit
  buckets: TokenDistBucket[]
}

export interface TopToken {
  symbol: string
  address: string
  logo: string | null
  profitPct: number | null
  realizedPnl: number | null
}

export interface OnchainPnlSummary {
  total: number | null
  realized: number | null
  unrealized: number | null
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Dedicated, disclosed display path for estimates blocked from MetricGrid. */
export function shapeOnchainPnl(extras: Record<string, unknown>): OnchainPnlSummary | null {
  const out = {
    total: finiteOrNull(extras.onchain_total_pnl),
    realized: finiteOrNull(extras.onchain_realized_pnl),
    unrealized: finiteOrNull(extras.onchain_unrealized_pnl),
  }
  return Object.values(out).some((value) => value !== null) ? out : null
}

export function shapeOnchainQuality(extras: Record<string, unknown>): StoredOnchainQuality | null {
  return readStoredOnchainQuality(extras)
}

function shapeDistributionBuckets(
  td: unknown,
  unit: TokenDistributionUnit
): TokenDistribution | null {
  if (!td || typeof td !== 'object') return null
  const order: Array<{ key: TokenDistBucket['key']; positive: boolean }> = [
    { key: 'gt_500', positive: true },
    { key: 'p0_500', positive: true },
    { key: 'n50_0', positive: false },
    { key: 'lt_n50', positive: false },
  ]
  const buckets = order.map(({ key, positive }) => {
    const n = Number((td as Record<string, unknown>)[key])
    return { key, positive, count: Number.isFinite(n) && n >= 0 ? Math.round(n) : 0 }
  })
  return buckets.some((b) => b.count > 0) ? { unit, buckets } : null
}

/**
 * Unit-aware distribution selection. Explicit exchange percentages win over
 * on-chain dollar estimates. Legacy generic rows are accepted only when no
 * onchain_* trace exists; mixed rows without a unit fail closed.
 */
export function shapeTokenDistribution(extras: Record<string, unknown>): TokenDistribution | null {
  if (extras.token_distribution_unit === 'pnl_percent') {
    const native = shapeDistributionBuckets(extras.token_distribution, 'pnl_percent')
    if (native) return native
  }

  if (extras.onchain_token_distribution_unit === 'realized_pnl_usd') {
    const estimated = shapeDistributionBuckets(
      extras.onchain_token_distribution_usd,
      'realized_pnl_usd'
    )
    if (estimated) return estimated
  }

  const hasExplicitGenericUnit =
    extras.token_distribution_unit !== null && extras.token_distribution_unit !== undefined
  const hasOnchainTrace = Object.keys(extras).some((key) => key.startsWith('onchain_'))
  return !hasExplicitGenericUnit && !hasOnchainTrace
    ? shapeDistributionBuckets(extras.token_distribution, 'pnl_percent')
    : null
}

function shapeTopTokenList(list: unknown, includeProfitPct: boolean): TopToken[] | null {
  if (!Array.isArray(list)) return null
  const out = list
    .filter((token): token is Record<string, unknown> =>
      Boolean(token && typeof token === 'object')
    )
    .filter((t) => typeof t.symbol === 'string' && t.symbol)
    .map((t) => ({
      symbol: String(t.symbol),
      address: typeof t.address === 'string' ? t.address : '',
      logo: typeof t.logo === 'string' ? t.logo : null,
      profitPct: includeProfitPct ? finiteOrNull(t.profit_pct) : null,
      realizedPnl: finiteOrNull(t.realized_pnl),
    }))
  return out.length > 0 ? out : null
}

/**
 * Source-aware top-token selection. Explicit exchange-native data wins and may
 * include the upstream return percentage. Reconstructed on-chain data is kept
 * separate and can display realized dollars only. Old generic rows are shown
 * only when there is no onchain_* trace; historical mixed rows fail closed.
 */
export function shapeTopTokens(extras: Record<string, unknown>): TopToken[] | null {
  if (extras.top_earning_tokens_provenance === 'source_native') {
    const native = shapeTopTokenList(extras.top_earning_tokens, true)
    if (native) return native
  }

  if (extras.onchain_top_earning_tokens_provenance === 'onchain-computed') {
    const estimated = shapeTopTokenList(extras.onchain_top_earning_tokens, false)
    if (estimated) return estimated
  }

  const hasExplicitGenericProvenance =
    extras.top_earning_tokens_provenance !== null &&
    extras.top_earning_tokens_provenance !== undefined
  const hasOnchainTrace = Object.keys(extras).some((key) => key.startsWith('onchain_'))
  return !hasExplicitGenericProvenance && !hasOnchainTrace
    ? shapeTopTokenList(extras.top_earning_tokens, true)
    : null
}

/**
 * extras.pnl_calendar ([{date, pnl}] DAILY) → cumulative [{date, roi, pnl}] that
 * PnlCalendarHeatmap consumes (it re-derives daily deltas internally, so we must
 * hand it a CUMULATIVE series or the colours would be wrong). roi is left 0 — the
 * heatmap colours by pnl only. Null when absent/too short to render.
 */
export function shapePnlCalendar(
  extras: Record<string, unknown>
): Array<{ date: string; roi: number; pnl: number }> | null {
  const list = Array.isArray(extras.pnl_calendar)
    ? (extras.pnl_calendar as Array<Record<string, unknown>>)
    : []
  let cum = 0
  const out: Array<{ date: string; roi: number; pnl: number }> = []
  for (const d of list) {
    const date = typeof d.date === 'string' ? d.date : null
    const pnl = typeof d.pnl === 'number' ? d.pnl : Number(d.pnl)
    if (!date || !Number.isFinite(pnl)) continue
    cum += pnl
    out.push({ date, roi: 0, pnl: cum })
  }
  return out.length > 3 ? out : null
}
