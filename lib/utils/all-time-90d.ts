/**
 * Sources whose "90D" figures are really all-time (lifetime) numbers: the
 * upstream API has no native 90-day window (owner decision "方案 A": use the
 * source's native allTime for the 90D board and disclose it).
 *
 * Both the public serving slug (`hyperliquid`) and the legacy connector slug
 * (`hyperliquid_perp`) are listed — the detail-page disclosure previously
 * checked only `hyperliquid_perp` and so never showed for public rows.
 */
export const ALLTIME_90D_SOURCES: ReadonlySet<string> = new Set(['hyperliquid', 'hyperliquid_perp'])

export function isAllTime90dSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && ALLTIME_90D_SOURCES.has(source.toLowerCase())
}
