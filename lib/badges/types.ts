/**
 * Achievement Badge Types
 *
 * Defines all available badges that traders can earn based on their performance.
 */

export type BadgeId =
  | 'top10'
  | 'top100'
  | 'high_winrate'
  | 'low_drawdown'
  | 'high_roi'

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
  top100: {
    id: 'top100',
    name: { en: 'Top 100', zh: '前100名' },
    description: {
      en: 'Ranked in the top 100 traders globally',
      zh: '全球交易员排名前100',
    },
    icon: 'award',
    color: 'var(--color-medal-bronze)',
    rarity: 'rare',
    category: 'rank',
  },
  high_winrate: {
    id: 'high_winrate',
    name: { en: 'Sharp Shooter', zh: '神枪手' },
    description: {
      en: 'Maintains win rate above 65%',
      zh: '保持胜率超过65%',
    },
    icon: 'target',
    color: 'var(--color-accent-error)',
    rarity: 'rare',
    category: 'performance',
  },
  low_drawdown: {
    id: 'low_drawdown',
    name: { en: 'Risk Master', zh: '风控大师' },
    description: {
      en: 'Maximum drawdown below 15%',
      zh: '最大回撤低于15%',
    },
    icon: 'shield',
    color: 'var(--color-chart-blue)',
    rarity: 'rare',
    category: 'performance',
  },
  high_roi: {
    id: 'high_roi',
    name: { en: 'High Performer', zh: '高收益' },
    description: {
      en: 'ROI exceeds 100% in 90 days',
      zh: '90天内ROI超过100%',
    },
    icon: 'rocket',
    color: 'var(--color-accent-warning)',
    rarity: 'epic',
    category: 'performance',
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
