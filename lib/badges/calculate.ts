/**
 * Badge Calculation Logic — Simplified (5 badges)
 */

import type { BadgeId, EarnedBadge } from './types'
import { BADGE_DEFINITIONS } from './types'

interface TraderStats {
  handle: string
  rank?: number | null
  roi?: number | null
  roi90d?: number | null
  winRate?: number | null
  maxDrawdown?: number | null
}

export function calculateBadges(stats: TraderStats): EarnedBadge[] {
  const badges: EarnedBadge[] = []
  const now = new Date().toISOString()

  // Top 10
  if (stats.rank != null && stats.rank <= 10) {
    badges.push({ ...BADGE_DEFINITIONS.top10, earnedAt: now, metadata: { rank: stats.rank } })
  }
  // Top 100
  else if (stats.rank != null && stats.rank <= 100) {
    badges.push({ ...BADGE_DEFINITIONS.top100, earnedAt: now, metadata: { rank: stats.rank } })
  }

  // Win rate 65%+
  if (stats.winRate != null && stats.winRate >= 65) {
    badges.push({ ...BADGE_DEFINITIONS.high_winrate, earnedAt: now, metadata: { winRate: stats.winRate } })
  }

  // Low drawdown < 15%
  if (stats.maxDrawdown != null && stats.maxDrawdown < 15 && stats.maxDrawdown > 0) {
    badges.push({ ...BADGE_DEFINITIONS.low_drawdown, earnedAt: now, metadata: { maxDrawdown: stats.maxDrawdown } })
  }

  // High ROI 100%+ in 90 days
  const roi90d = stats.roi90d ?? stats.roi
  if (roi90d != null && roi90d >= 100) {
    badges.push({ ...BADGE_DEFINITIONS.high_roi, earnedAt: now, metadata: { roi: roi90d } })
  }

  const rarityOrder = { legendary: 0, epic: 1, rare: 2, common: 3 }
  badges.sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity])
  return badges
}

export function getPrimaryBadge(badges: EarnedBadge[]): EarnedBadge | null {
  return badges.length > 0 ? badges[0] : null
}

export function hasBadge(stats: TraderStats, badgeId: BadgeId): boolean {
  return calculateBadges(stats).some(b => b.id === badgeId)
}
