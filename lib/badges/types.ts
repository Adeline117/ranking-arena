/**
 * Achievement Badge Types
 *
 * Defines all available badges that traders can earn based on their performance.
 */

export type BadgeId = 'top10'

export interface Badge {
  id: BadgeId
  name: { en: string; zh: string }
  description: { en: string; zh: string }
  icon: string // SVG path or icon name
  color: string // Tailwind color class or hex
  rarity: 'common' | 'rare' | 'epic' | 'legendary'
  category: 'rank' | 'performance' | 'web3' | 'special'
}

export interface EarnedBadge extends Badge {
  earnedAt: string // ISO date
  metadata?: Record<string, unknown>
}

export const BADGE_DEFINITIONS: Record<BadgeId, Badge> = {
  top10: {
    id: 'top10',
    name: { en: 'Top 10', zh: '前10名' },
    description: {
      en: 'Ranked in the top 10 traders globally',
      zh: '全球交易员排名前10',
    },
    icon: 'trophy',
    color: 'var(--color-medal-gold)',
    rarity: 'legendary',
    category: 'rank',
  },
}

export function getBadgeDefinition(id: BadgeId): Badge {
  return BADGE_DEFINITIONS[id]
}

export function getBadgesByCategory(category: Badge['category']): Badge[] {
  return Object.values(BADGE_DEFINITIONS).filter(b => b.category === category)
}

export function getBadgesByRarity(rarity: Badge['rarity']): Badge[] {
  return Object.values(BADGE_DEFINITIONS).filter(b => b.rarity === rarity)
}
