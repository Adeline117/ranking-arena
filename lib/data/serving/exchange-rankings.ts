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
// The route has a 4s outer render deadline. Abort slightly earlier so the
// PostgREST request releases its connection instead of continuing after the
// page has already rendered a retry state.
export const EXCHANGE_RANKINGS_QUERY_TIMEOUT_MS = 3_500

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

export async function getExchangeRankings(
  supabase: SupabaseClient,
  timeframe: ExchangeRankingsTimeframe
): Promise<ExchangeRankings> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EXCHANGE_RANKINGS_QUERY_TIMEOUT_MS)
  let response: Awaited<ReturnType<SupabaseClient['rpc']>>
  try {
    const request = supabase
      .rpc('arena_exchange_rankings', { p_timeframe: timeframe })
      .abortSignal(controller.signal)
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error(`Exchange rankings ${timeframe}D query timed out`)),
        { once: true }
      )
    })
    response = await Promise.race([request, interrupted])
  } catch (cause) {
    throw new Error(`Exchange rankings request failed for ${timeframe}D`, { cause })
  } finally {
    clearTimeout(timeout)
  }

  const { data, error } = response
  logRpcError('arena_exchange_rankings', error)
  if (error) {
    throw new Error(`Exchange rankings request failed for ${timeframe}D`, { cause: error })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
  }
  const d = data as Record<string, unknown>
  if (
    !hasExactKeys(d, ['nonLegacyCount', 'timeframe', 'rows']) ||
    !Number.isSafeInteger(d.nonLegacyCount) ||
    Number(d.nonLegacyCount) < 0 ||
    d.timeframe !== timeframe ||
    !Array.isArray(d.rows) ||
    d.rows.length > Number(d.nonLegacyCount)
  ) {
    throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
  }

  const rows: ExchangeRankingRow[] = []
  const seenSources = new Set<string>()
  for (const raw of d.rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
    }
    const r = raw as Record<string, unknown>
    const source = r.source
    const exchangeSlug = r.exchangeSlug
    const exchangeName = r.exchangeName
    const productType = r.productType
    const currency = r.currency
    const asOf = r.asOf
    const rankedTraders = r.rankedTraders
    const copierPnl = r.copierPnl
    if (
      !hasExactKeys(r, [
        'source',
        'exchangeSlug',
        'exchangeName',
        'productType',
        'currency',
        'derived',
        'asOf',
        'rankedTraders',
        'medianRoi',
        'topDecileRoi',
        'pctProfitable',
        'copierPnl',
        'botShare',
      ]) ||
      typeof source !== 'string' ||
      source.length === 0 ||
      seenSources.has(source) ||
      typeof exchangeSlug !== 'string' ||
      exchangeSlug.length === 0 ||
      typeof exchangeName !== 'string' ||
      exchangeName.length === 0 ||
      !PRODUCT_TYPES.has(productType as string) ||
      !CURRENCIES.has(currency as string) ||
      typeof r.derived !== 'boolean' ||
      typeof asOf !== 'string' ||
      !Number.isFinite(Date.parse(asOf)) ||
      !Number.isSafeInteger(rankedTraders) ||
      Number(rankedTraders) < 0 ||
      !isNullableFiniteNumber(r.medianRoi) ||
      !isNullableFiniteNumber(r.topDecileRoi) ||
      !isNullableFiniteNumber(r.pctProfitable) ||
      !isNullableFiniteNumber(r.botShare)
    ) {
      throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
    }

    let parsedCopierPnl: Money | null = null
    if (copierPnl !== null) {
      if (!copierPnl || typeof copierPnl !== 'object' || Array.isArray(copierPnl)) {
        throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
      }
      const money = copierPnl as Record<string, unknown>
      if (
        !hasExactKeys(money, ['value', 'currency']) ||
        typeof money.value !== 'number' ||
        !Number.isFinite(money.value) ||
        money.currency !== currency
      ) {
        throw new Error(`Exchange rankings returned an invalid ${timeframe}D response`)
      }
      parsedCopierPnl = { value: money.value, currency: currency as ServingCurrency }
    }

    seenSources.add(source)

    rows.push({
      source,
      exchangeSlug,
      exchangeName,
      productType: productType as ExchangeRankingRow['productType'],
      currency: currency as ServingCurrency,
      rankedTraders: Number(rankedTraders),
      medianRoi: r.medianRoi,
      topDecileRoi: r.topDecileRoi,
      pctProfitable: r.pctProfitable,
      copierPnl: parsedCopierPnl,
      botShare: r.botShare,
      provenance: { source, asOf, derived: r.derived },
    })
  }

  return {
    nonLegacyCount: Number(d.nonLegacyCount),
    timeframe,
    rows,
  }
}
