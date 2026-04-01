/**
 * Achievement system — tracks user milestones and returns unlock info for toast display.
 * Achievements are stored in localStorage (keyed by userId) since user_profiles
 * doesn't have a metadata column and this avoids a DB migration.
 */

export interface Achievement {
  key: AchievementKey
  title: string
  titleZh: string
  description: string
  descriptionZh: string
  icon: string
}

export type AchievementKey =
  | 'first_watchlist'
  | 'first_comparison'
  | 'first_post'
  | 'explorer_5'
  | 'pro_subscriber'
  | 'social_butterfly'

export const ACHIEVEMENTS: Record<AchievementKey, Achievement> = {
  first_watchlist: {
    key: 'first_watchlist',
    title: 'Watchlist Pioneer',
    titleZh: '关注先锋',
    description: 'Added first trader to watchlist',
    descriptionZh: '将第一位交易员加入关注列表',
    icon: 'star',
  },
  first_comparison: {
    key: 'first_comparison',
    title: 'Analyst',
    titleZh: '分析师',
    description: 'First trader comparison',
    descriptionZh: '首次对比交易员',
    icon: 'chart',
  },
  first_post: {
    key: 'first_post',
    title: 'Voice of Arena',
    titleZh: '发帖达人',
    description: 'Published first post',
    descriptionZh: '发布了第一篇帖子',
    icon: 'pen',
  },
  explorer_5: {
    key: 'explorer_5',
    title: 'Explorer',
    titleZh: '探索者',
    description: 'Viewed 5 different trader profiles',
    descriptionZh: '浏览了 5 位不同交易员的主页',
    icon: 'compass',
  },
  pro_subscriber: {
    key: 'pro_subscriber',
    title: 'Pro Member',
    titleZh: 'Pro 会员',
    description: 'Subscribed to Pro',
    descriptionZh: '订阅了 Pro 会员',
    icon: 'crown',
  },
  social_butterfly: {
    key: 'social_butterfly',
    title: 'Social Butterfly',
    titleZh: '社交达人',
    description: 'Joined first group',
    descriptionZh: '加入了第一个群组',
    icon: 'users',
  },
}

const STORAGE_KEY_PREFIX = 'arena_achievements_'

function getStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`
}

/**
 * Get all unlocked achievements for a user.
 */
export function getUnlockedAchievements(userId: string): Record<string, { unlockedAt: string }> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(getStorageKey(userId))
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, { unlockedAt: string }>
  } catch {
    return {}
  }
}

/**
 * Check if an achievement is already unlocked, and if not, mark it as unlocked.
 * Returns the achievement info if newly unlocked, or null if already unlocked.
 */
export function checkAndUnlock(userId: string, achievementKey: AchievementKey): Achievement | null {
  if (typeof window === 'undefined') return null
  if (!userId) return null

  const achievement = ACHIEVEMENTS[achievementKey]
  if (!achievement) return null

  const unlocked = getUnlockedAchievements(userId)
  if (unlocked[achievementKey]) return null // Already unlocked

  // Mark as unlocked
  unlocked[achievementKey] = { unlockedAt: new Date().toISOString() }
  try {
    localStorage.setItem(getStorageKey(userId), JSON.stringify(unlocked))
  } catch {
    // localStorage full or unavailable — silently fail
    return null
  }

  return achievement
}

/**
 * Track a trader profile view and check if explorer_5 should be unlocked.
 */
export function trackTraderView(userId: string, traderId: string): Achievement | null {
  if (typeof window === 'undefined') return null
  if (!userId) return null

  const viewKey = `arena_trader_views_${userId}`
  let views: string[] = []
  try {
    const raw = localStorage.getItem(viewKey)
    if (raw) views = JSON.parse(raw) as string[]
  } catch {
    views = []
  }

  if (!views.includes(traderId)) {
    views.push(traderId)
    try {
      localStorage.setItem(viewKey, JSON.stringify(views))
    } catch {
      // ignore
    }
  }

  if (views.length >= 5) {
    return checkAndUnlock(userId, 'explorer_5')
  }

  return null
}
