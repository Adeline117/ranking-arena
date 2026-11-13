/**
 * The board window a serving headline (rank / ROI) was taken from. The trader
 * header prefers the 90D board but falls back to 30D or the first available
 * entry, so anything that labels those numbers (e.g. the share rank card) must
 * carry the real window instead of assuming 90D.
 */
export type HeadlineWindow = '7d' | '30d' | '90d'

export function headlineWindowFor(
  timeframe: number | null | undefined
): HeadlineWindow | undefined {
  if (timeframe === 7 || timeframe === 30 || timeframe === 90) return `${timeframe}d`
  return undefined
}
