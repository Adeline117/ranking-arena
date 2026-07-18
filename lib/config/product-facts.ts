/**
 * Product facts that affect trust-sensitive UI copy.
 *
 * Dynamic counts come from `getHeroStats()` / `/api/hero-stats`; this module
 * owns the safe fallback and the operational cadence so marketing pages never
 * invent their own "45+" / "30 min" claims again.
 */

export const PRODUCT_FACTS = {
  /** Live 90D source boards represented in the public rankings. */
  fallbackSourceBoardCount: 28,
  /** @deprecated Compatibility alias; this count is source boards, not exchanges. */
  fallbackExchangeCount: 28,
  /** Ranked 90D population, also used as the percentile denominator fallback. */
  fallbackRankedTraderCount: 9_600,
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

export function formatTrackedSourceCoverage(count?: number | null): string {
  return typeof count === 'number' && Number.isInteger(count) && count > 0
    ? `${count} tracked source families`
    : 'tracked public sources'
}

export interface ProductFactsSnapshot {
  sourceBoardCount: number
  /** @deprecated Compatibility alias; use sourceBoardCount. */
  exchangeCount: number
  rankedTraderCount: number
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
  const sourceBoardCount =
    typeof input?.sourceBoardCount === 'number' && input.sourceBoardCount > 0
      ? input.sourceBoardCount
      : typeof input?.exchangeCount === 'number' && input.exchangeCount > 0
        ? input.exchangeCount
        : PRODUCT_FACTS.fallbackSourceBoardCount
  const rankedTraderCount =
    typeof input?.traderCount === 'number' && input.traderCount > 0
      ? input.traderCount
      : PRODUCT_FACTS.fallbackRankedTraderCount

  return {
    sourceBoardCount,
    exchangeCount: sourceBoardCount,
    rankedTraderCount,
    leaderboardRefreshHours: PRODUCT_FACTS.leaderboardRefreshHours,
    leaderboardRefreshLabel: `${PRODUCT_FACTS.leaderboardRefreshHours}h`,
    sourceRefreshLabel: `${PRODUCT_FACTS.sourceRefreshHours.min}-${PRODUCT_FACTS.sourceRefreshHours.max}h`,
    isFallback: input?.isDefault === true || !input,
  }
}

export function formatRankedTraderCount(count: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(count)
}
