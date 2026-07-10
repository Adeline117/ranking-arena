import { tokens } from '@/lib/design-tokens'

/**
 * getBadgeStyle — medal-tier colouring shared by the percentile badges.
 *
 * NOTE: the former default-export `RankPercentileBadge` ("Top X% on {platform}")
 * was REMOVED. It divided the GLOBAL cross-exchange `leaderboard_ranks.rank` by a
 * PER-PLATFORM trader count (from /api/rankings/platform-stats), which fabricated
 * a wrong "Top X% on {exchange}" (e.g. binance ranks span 39–8809 across a board
 * of 860 traders) and hid deserved badges. The accurate cross-exchange percentile
 * is rendered by `CrossExchangePercentileBadge`, which reuses `getBadgeStyle`.
 */
export function getBadgeStyle(percentile: number): { bg: string; color: string; border: string } {
  if (percentile >= 99) {
    // Top 1% — gold
    const gold = tokens.colors.medal.gold
    return {
      bg: `color-mix(in srgb, ${gold} 12%, transparent)`,
      color: gold,
      border: `color-mix(in srgb, ${gold} 30%, transparent)`,
    }
  }
  if (percentile >= 95) {
    // Top 5% — silver
    const silver = tokens.colors.medal.silver
    return {
      bg: `color-mix(in srgb, ${silver} 12%, transparent)`,
      color: silver,
      border: `color-mix(in srgb, ${silver} 30%, transparent)`,
    }
  }
  if (percentile >= 90) {
    // Top 10% — bronze
    const bronze = tokens.colors.medal.bronze
    return {
      bg: `color-mix(in srgb, ${bronze} 12%, transparent)`,
      color: bronze,
      border: `color-mix(in srgb, ${bronze} 30%, transparent)`,
    }
  }
  // Default
  return {
    bg: 'var(--color-bg-tertiary)',
    color: 'var(--color-text-secondary)',
    border: 'var(--color-border-primary)',
  }
}
