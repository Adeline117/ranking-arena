/**
 * Product facts that affect trust-sensitive UI copy.
 *
 * Dynamic counts come from `getHeroStats()` / `/api/hero-stats`. There is no
 * hard-coded fallback count: a number is shown only when it is a live fact
 * (see `publicCount`). When the source is unavailable — or the public board
 * is genuinely empty — pages render count-free copy instead of a stale figure
 * such as the old "9,600 traders / 28 boards", which kept appearing even
 * while the rankings were empty.
 */

export const PRODUCT_FACTS = {
  /** BullMQ `SCORE_INTERVALS_MS` in worker/src/scheduler.ts. */
  leaderboardRefreshHours: 2,
  /** Typical upstream refresh range; individual sources may differ. */
  sourceRefreshHours: { min: 3, max: 6 },
} as const

/**
 * Homepage copy tied to operational facts. Keep these claims next to the
 * scheduler cadence so metadata and social cards cannot drift back to
 * "real-time" or invent a separate coverage count.
 */
export const HOMEPAGE_TRUST_COPY = {
  metadataDescription: `Explore public crypto trader rankings, community discussions, and trading resources. Rankings are recomputed every ${PRODUCT_FACTS.leaderboardRefreshHours} hours from the latest available source data.`,
  ogCoverageLabel: 'Tracked Public Sources',
  ogCadenceLabel: `Recomputed Every ${PRODUCT_FACTS.leaderboardRefreshHours}h`,
} as const

export function formatLiveSourceBoardCoverage(count?: number | null): string {
  return typeof count === 'number' && Number.isInteger(count) && count > 0
    ? `${count} live ranking source boards`
    : 'live public ranking sources'
}

/** A count that may be stated publicly: a live, positive integer — else null. */
export function publicCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export interface ProductFactsSnapshot {
  /** Live source-board count, or null when unknown / empty (render no number). */
  sourceBoardCount: number | null
  /** Live ranked-trader count, or null when unknown / empty (render no number). */
  rankedTraderCount: number | null
  leaderboardRefreshHours: number
  leaderboardRefreshLabel: string
  sourceRefreshLabel: string
  isFallback: boolean
}

export function buildProductFactsSnapshot(input?: {
  sourceBoardCount?: number | null
  /** Legacy /api/hero-stats field accepted during the contract transition. */
  exchangeCount?: number | null
  traderCount?: number | null
  isDefault?: boolean
}): ProductFactsSnapshot {
  // Defaults returned by a failed lookup are not facts, whatever they hold.
  const live = input !== undefined && input.isDefault !== true
  const sourceBoardCount = live
    ? (publicCount(input.sourceBoardCount) ?? publicCount(input.exchangeCount))
    : null
  const rankedTraderCount = live ? publicCount(input.traderCount) : null

  return {
    sourceBoardCount,
    rankedTraderCount,
    leaderboardRefreshHours: PRODUCT_FACTS.leaderboardRefreshHours,
    leaderboardRefreshLabel: `${PRODUCT_FACTS.leaderboardRefreshHours}h`,
    sourceRefreshLabel: `${PRODUCT_FACTS.sourceRefreshHours.min}-${PRODUCT_FACTS.sourceRefreshHours.max}h`,
    isFallback: !live,
  }
}

export function formatRankedTraderCount(count: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(count)
}
