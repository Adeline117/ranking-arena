/**
 * Achievement Badge Types
 *
 * Defines all available badges that traders can earn based on their performance.
 */

export type BadgeId =
  | 'top10'
  | 'top50'
  | 'top100'
  | 'verified_onchain'
  | 'high_winrate'
  | 'consistent_performer'
  | 'low_drawdown'
  | 'high_roi'
  | 'whale'
  | 'veteran'
  | 'rising_star'
  | 'nft_holder'

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
    color: '#FFD700',
    rarity: 'legendary',
    category: 'rank',
  },
  top50: {
    id: 'top50',
    name: { en: 'Top 50', zh: '前50名' },
    description: {
      en: 'Ranked in the top 50 traders globally',
      zh: '全球交易员排名前50',
    },
    icon: 'medal',
    color: '#C0C0C0',
    rarity: 'epic',
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
    color: '#CD7F32',
    rarity: 'rare',
    category: 'rank',
  },
  verified_onchain: {
    id: 'verified_onchain',
    name: { en: 'On-Chain Verified', zh: '链上验证' },
    description: {
      en: 'Arena Score verified on-chain via EAS',
      zh: '通过 EAS 进行链上 Arena Score 验证',
    },
    icon: 'shield-check',
    color: '#2fe57d',
    rarity: 'rare',
    category: 'web3',
  },
  high_winrate: {
    id: 'high_winrate',
    name: { en: 'Sharp Shooter', zh: '神枪手' },
    description: {
      en: 'Maintains win rate above 65%',
      zh: '保持胜率超过65%',
    },
    icon: 'target',
    color: '#FF6B6B',
    rarity: 'rare',
    category: 'performance',
  },
  consistent_performer: {
    id: 'consistent_performer',
    name: { en: 'Consistent', zh: '稳定盈利' },
    description: {
      en: 'Profitable for 3+ consecutive months',
      zh: '连续3个月以上盈利',
    },
    icon: 'trending-up',
    color: '#4ECDC4',
    rarity: 'epic',
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
    color: '#45B7D1',
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
    color: '#F39C12',
    rarity: 'epic',
    category: 'performance',
  },
  whale: {
    id: 'whale',
    name: { en: 'Whale', zh: '巨鲸' },
    description: {
      en: 'Manages over $1M in AUM',
      zh: '管理资产超过100万美元',
    },
    icon: 'anchor',
    color: '#3498DB',
    rarity: 'legendary',
    category: 'special',
  },
  veteran: {
    id: 'veteran',
    name: { en: 'Veteran', zh: '老将' },
    description: {
      en: 'Trading for over 2 years',
      zh: '交易超过2年',
    },
    icon: 'clock',
    color: '#9B59B6',
    rarity: 'rare',
    category: 'special',
  },
  rising_star: {
    id: 'rising_star',
    name: { en: 'Rising Star', zh: '新星' },
    description: {
      en: 'Top performer among new traders',
      zh: '新交易员中的佼佼者',
    },
    icon: 'star',
    color: '#E74C3C',
    rarity: 'rare',
    category: 'special',
  },
  nft_holder: {
    id: 'nft_holder',
    name: { en: 'Pro NFT', zh: 'Pro NFT' },
    description: {
      en: 'Holds Arena Pro membership NFT',
      zh: '持有 Arena Pro 会员 NFT',
    },
    icon: 'hexagon',
    color: '#A855F7',
    rarity: 'rare',
    category: 'web3',
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
