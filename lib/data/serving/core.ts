/**
 * Core modules (spec §2.4-2): the stats block + chart series for ONE
 * timeframe, served warm from arena.trader_stats/trader_series via the
 * arena_core_modules RPC. Returns null when cold — the API route then
 * bridges to the Tier-C on-demand queue (lib/data/serving/tier-c.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logRpcError } from './log-rpc-error'
import type { ServingCurrency, ServingTimeframe, TraderCoreModules } from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

export function tfToInt(tf: ServingTimeframe): 0 | 7 | 30 | 90 {
  return tf === 'inception' ? 0 : tf
}

export function intToTf(n: number): ServingTimeframe {
  return n === 0 ? 'inception' : (n as 7 | 30 | 90)
}

/** Is an as_of timestamp within the freshness TTL? */
export function isFresh(asOf: string | null | undefined, ttlSeconds: number): boolean {
  if (!asOf) return false
  const t = Date.parse(asOf)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < ttlSeconds * 1000
}

export async function getCoreModules(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string,
  timeframe: ServingTimeframe
): Promise<TraderCoreModules | null> {
  const { data, error } = await supabase.rpc('arena_core_modules', {
    p_source: source,
    p_trader: exchangeTraderId,
    p_timeframe: tfToInt(timeframe),
  })
  logRpcError('arena_core_modules', error)
  if (error || !data) return null
  const d = data as Record<string, unknown>

  // Split the RPC stats blob: primitives stay in stats (the contract is
  // number|string|null), structured values (trading_preferences …) move
  // into extras so nothing is silently dropped.
  const stats: Record<string, number | string | null> = {}
  const extras: Record<string, unknown> = {
    ...((d.extras as Record<string, unknown>) ?? {}),
  }
  for (const [key, value] of Object.entries((d.stats as Record<string, unknown>) ?? {})) {
    if (value === null || typeof value === 'number' || typeof value === 'string') {
      stats[key] = value
    } else {
      extras[key] = value
    }
  }

  const series: TraderCoreModules['series'] = {}
  for (const [metric, points] of Object.entries((d.series as Record<string, unknown>) ?? {})) {
    if (Array.isArray(points)) {
      series[metric] = points as Array<{ ts: string; value: number }>
    }
  }

  const asOf = typeof d.asOf === 'string' ? d.asOf : new Date(0).toISOString()
  return {
    timeframe: intToTf(Number(d.timeframe)),
    stats,
    currency:
      typeof d.currency === 'string' && CURRENCIES.has(d.currency)
        ? (d.currency as ServingCurrency)
        : 'USDT',
    series,
    extras,
    provenance: { source, asOf },
    cacheState: 'warm',
  }
}
