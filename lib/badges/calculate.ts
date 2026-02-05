/**
 * Badge Calculation Logic
 *
 * Determines which badges a trader has earned based on their stats.
 */

import type { BadgeId, EarnedBadge } from './types'
import { BADGE_DEFINITIONS } from './types'

interface TraderStats {
  handle: string
  rank?: number | null
  arenaScore?: number | null
  roi?: number | null
  roi30d?: number | null
  roi90d?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
  aum?: number | null
  copiers?: number | null
  startDate?: string | null
  hasOnChainAttestation?: boolean
  hasNft?: boolean
  consecutiveProfitableMonths?: number
}

/**
 * Calculate all badges a trader has earned based on their stats.
 */
export function calculateBadges(stats: TraderStats): EarnedBadge[] {
  const badges: EarnedBadge[] = []
  const now = new Date().toISOString()

  // Rank badges
  if (stats.rank != null) {
    if (stats.rank <= 10) {
      badges.push({
        ...BADGE_DEFINITIONS.top10,
        earnedAt: now,
        metadata: { rank: stats.rank },
      })
    } else if (stats.rank <= 50) {
      badges.push({
        ...BADGE_DEFINITIONS.top50,
        earnedAt: now,
        metadata: { rank: stats.rank },
      })
    } else if (stats.rank <= 100) {
      badges.push({
        ...BADGE_DEFINITIONS.top100,
        earnedAt: now,
        metadata: { rank: stats.rank },
      })
    }
  }

  // On-chain verification
  if (stats.hasOnChainAttestation) {
    badges.push({
      ...BADGE_DEFINITIONS.verified_onchain,
      earnedAt: now,
    })
  }

  // NFT holder
  if (stats.hasNft) {
    badges.push({
      ...BADGE_DEFINITIONS.nft_holder,
      earnedAt: now,
    })
  }

  // Win rate badge (65%+)
  if (stats.winRate != null && stats.winRate >= 65) {
    badges.push({
      ...BADGE_DEFINITIONS.high_winrate,
      earnedAt: now,
      metadata: { winRate: stats.winRate },
    })
  }

  // Low drawdown badge (< 15%)
  if (stats.maxDrawdown != null && stats.maxDrawdown < 15 && stats.maxDrawdown > 0) {
    badges.push({
      ...BADGE_DEFINITIONS.low_drawdown,
      earnedAt: now,
      metadata: { maxDrawdown: stats.maxDrawdown },
    })
  }

  // High ROI badge (100%+ in 90 days)
  const roi90d = stats.roi90d ?? stats.roi
  if (roi90d != null && roi90d >= 100) {
    badges.push({
      ...BADGE_DEFINITIONS.high_roi,
      earnedAt: now,
      metadata: { roi: roi90d },
    })
  }

  // Whale badge ($1M+ AUM)
  if (stats.aum != null && stats.aum >= 1_000_000) {
    badges.push({
      ...BADGE_DEFINITIONS.whale,
      earnedAt: now,
      metadata: { aum: stats.aum },
    })
  }

  // Veteran badge (2+ years)
  if (stats.startDate) {
    const startDate = new Date(stats.startDate)
    const twoYearsAgo = new Date()
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)

    if (startDate <= twoYearsAgo) {
      badges.push({
        ...BADGE_DEFINITIONS.veteran,
        earnedAt: now,
        metadata: { startDate: stats.startDate },
      })
    }
  }

  // Consistent performer (3+ months profitable)
  if (stats.consecutiveProfitableMonths != null && stats.consecutiveProfitableMonths >= 3) {
    badges.push({
      ...BADGE_DEFINITIONS.consistent_performer,
      earnedAt: now,
      metadata: { months: stats.consecutiveProfitableMonths },
    })
  }

  // Rising star (new trader in top 500 with high growth)
  if (stats.startDate && stats.rank != null && stats.rank <= 500) {
    const startDate = new Date(stats.startDate)
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

    if (startDate >= sixMonthsAgo) {
      badges.push({
        ...BADGE_DEFINITIONS.rising_star,
        earnedAt: now,
        metadata: { rank: stats.rank, startDate: stats.startDate },
      })
    }
  }

  // Sort by rarity (legendary first)
  const rarityOrder = { legendary: 0, epic: 1, rare: 2, common: 3 }
  badges.sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity])

  return badges
}

/**
 * Get the primary badge (highest rarity) for display.
 */
export function getPrimaryBadge(badges: EarnedBadge[]): EarnedBadge | null {
  if (badges.length === 0) return null
  return badges[0] // Already sorted by rarity
}

/**
 * Check if trader qualifies for a specific badge.
 */
export function hasBadge(stats: TraderStats, badgeId: BadgeId): boolean {
  const badges = calculateBadges(stats)
  return badges.some(b => b.id === badgeId)
}
