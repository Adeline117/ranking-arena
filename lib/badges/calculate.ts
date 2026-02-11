/**
 * Badge Calculation — Only Top 10
 */
import type { BadgeId, EarnedBadge } from './types'
import { BADGE_DEFINITIONS } from './types'

interface TraderStats {
  handle: string
  rank?: number | null
}

export function calculateBadges(stats: TraderStats): EarnedBadge[] {
  if (stats.rank != null && stats.rank <= 10) {
    return [{
      ...BADGE_DEFINITIONS.top10,
      earnedAt: new Date().toISOString(),
      metadata: { rank: stats.rank },
    }]
  }
  return []
}

export function getPrimaryBadge(badges: EarnedBadge[]): EarnedBadge | null {
  return badges[0] ?? null
}

export function hasBadge(stats: TraderStats, badgeId: BadgeId): boolean {
  return calculateBadges(stats).some(b => b.id === badgeId)
}
