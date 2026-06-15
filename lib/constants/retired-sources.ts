/**
 * RETIRED sources — removed from the product entirely (ARENA_DATA_SPEC endgame).
 *
 * Distinct from DEAD_BLOCKED_PLATFORMS (lib/constants/exchanges.ts), which only
 * suppresses pipeline alerts and shows a "platform paused" banner while still
 * serving the last-known frozen data. A RETIRED source is gone: it has no
 * arena.* source, is absent from rankings/search, its rows were cold-archived
 * to the arena_archive schema (migration 20260615133232), and its trader detail
 * pages 404.
 *
 * These 12 are the spec-dropped exchanges (froze 2026-06-12 when their legacy
 * connectors were removed). bingx_spot is intentionally NOT here — it is an
 * arena 'shadow' source still in the doc.
 */
export const RETIRED_SOURCES: ReadonlySet<string> = new Set([
  'aevo',
  'bybit_spot',
  'copin',
  'dydx',
  'etoro',
  'gains',
  'jupiter_perps',
  'okx_web3',
  'polymarket',
  'toobit',
  'weex',
  'woox',
])

/** Is this source retired (removed from product → 404, archived)? */
export function isRetiredSource(source: string | null | undefined): boolean {
  return !!source && RETIRED_SOURCES.has(source)
}
