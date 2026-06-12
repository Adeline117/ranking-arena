/**
 * Capability matrix (spec §6 "capability matrix is data, not code"):
 * per-source timeframe availability, exposed metrics (observed non-NULL
 * coverage), record surfaces and copier depth — all derived server-side by
 * the arena_source_capabilities RPC from arena.sources + arena.trader_stats.
 * Adding an exchange never touches UI code.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { RecordKind, ServingCurrency, SourceCapability, TfAvailability } from './types'

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])
const DEPTHS: ReadonlySet<string> = new Set(['full', 'top10', 'top3_preview', 'none'])
const KINDS: readonly RecordKind[] = [
  'positions',
  'position_history',
  'orders',
  'transfers',
  'copiers',
]

function availability(tf: number, native: number[], derived: number[]): TfAvailability {
  if (native.includes(tf)) return 'native'
  if (derived.includes(tf)) return 'derived'
  return 'absent'
}

function intArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []
}

export async function getSourceCapabilities(
  supabase: SupabaseClient
): Promise<Record<string, SourceCapability>> {
  const { data, error } = await supabase.rpc('arena_source_capabilities')
  if (error || !data || typeof data !== 'object') return {}

  const out: Record<string, SourceCapability> = {}
  for (const [slug, rawCap] of Object.entries(data as Record<string, unknown>)) {
    if (!rawCap || typeof rawCap !== 'object') continue
    const c = rawCap as Record<string, unknown>
    const native = intArray(c.timeframesNative)
    const derived = intArray(c.timeframesDerived)
    const rawSurfaces = (c.surfaces as Record<string, unknown>) ?? {}
    const surfaces = {} as Record<RecordKind, boolean>
    for (const kind of KINDS) surfaces[kind] = rawSurfaces[kind] === true

    out[slug] = {
      timeframes: {
        '7': availability(7, native, derived),
        '30': availability(30, native, derived),
        '90': availability(90, native, derived),
      },
      // Bots store "since inception" as timeframe 0 (spec §1.1-B).
      inceptionTf: native.includes(0),
      metrics: Array.isArray(c.metrics) ? (c.metrics as string[]).filter(Boolean) : [],
      surfaces,
      copierDepth:
        typeof c.copierDepth === 'string' && DEPTHS.has(c.copierDepth)
          ? (c.copierDepth as SourceCapability['copierDepth'])
          : 'none',
      currency:
        typeof c.currency === 'string' && CURRENCIES.has(c.currency)
          ? (c.currency as ServingCurrency)
          : 'USDT',
      isOnchain: c.isOnchain === true,
      derivedBoardNote: derived.length > 0,
      exchangeName: typeof c.exchangeName === 'string' ? c.exchangeName : slug,
    }
  }
  return out
}
