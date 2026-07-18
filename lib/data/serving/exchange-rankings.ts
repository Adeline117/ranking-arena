/**
 * Exchange Rankings (ARENA_DATA_SPEC v1.2 §6.1): board-level aggregates per
 * active non-legacy serving source, computed server-side by the
 * arena_exchange_rankings RPC from the latest PASSED leaderboard snapshot +
 * trader_stats — zero extra scraping. Money values carry their currency and
 * are NEVER summed across sources (spec §5.8).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Money, Provenance, ServingCurrency } from './types'
import { logRpcError } from './log-rpc-error'

export type ExchangeRankingsTimeframe = 7 | 30 | 90

export interface ExchangeRankingRow {
  source: string
  exchangeSlug: string
  exchangeName: string
  productType: 'spot' | 'futures' | 'cfd' | 'onchain'
  currency: ServingCurrency
  rankedTraders: number
  medianRoi: number | null
  topDecileRoi: number | null
  pctProfitable: number | null
  /** Per-currency total — never add across rows with different currencies. */
  copierPnl: Money | null
  botShare: number | null
  provenance: Provenance
}

export interface ExchangeRankings {
  /** Sources with serving_mode <> 'legacy' — page gates on >= 3 (plan E.11). */
  nonLegacyCount: number
  timeframe: ExchangeRankingsTimeframe
  rows: ExchangeRankingRow[]
}

const PRODUCT_TYPES: ReadonlySet<string> = new Set(['spot', 'futures', 'cfd', 'onchain'])
const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function getExchangeRankings(
  supabase: SupabaseClient,
  timeframe: ExchangeRankingsTimeframe
): Promise<ExchangeRankings> {
  const { data, error } = await supabase.rpc('arena_exchange_rankings', {
    p_timeframe: timeframe,
  })
  logRpcError('arena_exchange_rankings', error)
  if (error) {
    throw new Error(`Exchange rankings request failed for ${timeframe}D`, { cause: error })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
  }
  const d = data as Record<string, unknown>
  const nonLegacyCount = numOrNull(d.nonLegacyCount)
  if (nonLegacyCount === null || !Array.isArray(d.rows)) {
    throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
  }

  const rows: ExchangeRankingRow[] = []
  for (const raw of d.rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.source !== 'string' || typeof r.asOf !== 'string') continue

    const currency = CURRENCIES.has(r.currency as string) ? (r.currency as ServingCurrency) : 'USDT'
    const copierPnlValue =
      r.copierPnl && typeof r.copierPnl === 'object'
        ? numOrNull((r.copierPnl as Record<string, unknown>).value)
        : null

    rows.push({
      source: r.source,
      exchangeSlug: typeof r.exchangeSlug === 'string' ? r.exchangeSlug : r.source,
      exchangeName: typeof r.exchangeName === 'string' ? r.exchangeName : r.source,
      productType: PRODUCT_TYPES.has(r.productType as string)
        ? (r.productType as ExchangeRankingRow['productType'])
        : 'futures',
      currency,
      rankedTraders: numOrNull(r.rankedTraders) ?? 0,
      medianRoi: numOrNull(r.medianRoi),
      topDecileRoi: numOrNull(r.topDecileRoi),
      pctProfitable: numOrNull(r.pctProfitable),
      copierPnl: copierPnlValue === null ? null : { value: copierPnlValue, currency },
      botShare: numOrNull(r.botShare),
      provenance: { source: r.source, asOf: r.asOf, derived: r.derived === true },
    })
  }

  return {
    nonLegacyCount,
    timeframe,
    rows,
  }
}
