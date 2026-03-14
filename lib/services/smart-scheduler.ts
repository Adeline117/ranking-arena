/**
 * Smart Scheduler Service
 *
 * Dynamically adjusts refresh frequencies based on trader activity levels.
 * Hot traders (Top 100) get frequent updates, dormant traders get sparse updates.
 */

import { createLogger } from '../utils/logger'

const schedulerLogger = createLogger('Scheduler')

// ============================================
// Types
// ============================================

export type ActivityTier = 'hot' | 'active' | 'normal' | 'dormant'

export interface ScheduleConfig {
  /** Refresh interval in minutes */
  intervalMinutes: number
  /** Priority (lower = higher priority) */
  priority: number
  /** Description */
  description: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderActivity {
  traderId: string
  platform: string
  rank?: number
  lastTradeAt?: Date
  followers?: number
  viewsLast24h?: number
}

// ============================================
// Constants
// ============================================

/** Get schedule configuration with environment variable overrides */
function getTierSchedules(): Record<ActivityTier, ScheduleConfig> {
  return {
    hot: {
      intervalMinutes: parseInt(process.env.SMART_SCHEDULER_HOT_INTERVAL_MINUTES || '15', 10),
      priority: 10,
      description: 'Top 100 traders - frequent updates',
    },
    active: {
      intervalMinutes: parseInt(process.env.SMART_SCHEDULER_ACTIVE_INTERVAL_MINUTES || '60', 10),
      priority: 20,
      description: 'Active traders (rank 101-500)',
    },
    normal: {
      intervalMinutes: parseInt(process.env.SMART_SCHEDULER_NORMAL_INTERVAL_MINUTES || '240', 10),
      priority: 30,
      description: 'Normal traders (rank 501-2000)',
    },
    dormant: {
      intervalMinutes: parseInt(process.env.SMART_SCHEDULER_DORMANT_INTERVAL_MINUTES || '1440', 10),
      priority: 40,
      description: 'Dormant traders (24h updates)',
    },
  }
}

/** Schedule configurations by activity tier */
export const TIER_SCHEDULES = getTierSchedules()

/** Tier classification thresholds (configurable via env vars) */
export const TIER_THRESHOLDS = {
  hot: {
    rank: parseInt(process.env.SMART_SCHEDULER_HOT_RANK_THRESHOLD || '100', 10),
    followers: parseInt(process.env.SMART_SCHEDULER_HOT_FOLLOWERS_THRESHOLD || '10000', 10),
    viewsLast24h: parseInt(process.env.SMART_SCHEDULER_HOT_VIEWS_THRESHOLD || '1000', 10),
  },
  active: {
    rank: parseInt(process.env.SMART_SCHEDULER_ACTIVE_RANK_THRESHOLD || '500', 10),
    followers: parseInt(process.env.SMART_SCHEDULER_ACTIVE_FOLLOWERS_THRESHOLD || '1000', 10),
    lastTradeHours: 24,
  },
  normal: {
    rank: parseInt(process.env.SMART_SCHEDULER_NORMAL_RANK_THRESHOLD || '2000', 10),
    lastTradeDays: 7,
  },
}

// ============================================
// Tier Classification
// ============================================

/**
 * Determine activity tier based on trader metrics
 */
export function classifyActivityTier(activity: TraderActivity): ActivityTier {
  const { rank, lastTradeAt, followers, viewsLast24h } = activity

  // Hot tier: Top performers OR very active
  if (rank !== undefined && rank <= TIER_THRESHOLDS.hot.rank) {
    return 'hot'
  }
  if (viewsLast24h !== undefined && viewsLast24h > TIER_THRESHOLDS.hot.viewsLast24h) {
    return 'hot'
  }
  if (followers !== undefined && followers > TIER_THRESHOLDS.hot.followers) {
    return 'hot'
  }

  // Active tier: Regular activity
  if (rank !== undefined && rank <= TIER_THRESHOLDS.active.rank) {
    return 'active'
  }
  if (lastTradeAt) {
    const hoursSinceLastTrade = (Date.now() - lastTradeAt.getTime()) / (1000 * 60 * 60)
    if (hoursSinceLastTrade < TIER_THRESHOLDS.active.lastTradeHours) {
      return 'active'
    }
  }
  if (followers !== undefined && followers > TIER_THRESHOLDS.active.followers) {
    return 'active'
  }

  // Normal tier: Moderate activity
  if (rank !== undefined && rank <= TIER_THRESHOLDS.normal.rank) {
    return 'normal'
  }
  if (lastTradeAt) {
    const daysSinceLastTrade = (Date.now() - lastTradeAt.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceLastTrade < TIER_THRESHOLDS.normal.lastTradeDays) {
      return 'normal'
    }
  }

  // Dormant tier: Everything else
  return 'dormant'
}

/**
 * Get schedule configuration for a trader
 */
export function getScheduleForTrader(activity: TraderActivity): ScheduleConfig {
  const tier = classifyActivityTier(activity)
  return TIER_SCHEDULES[tier]
}

// ============================================
// Batch Scheduling
// ============================================

export interface ScheduledJob {
  traderId: string
  platform: string
  tier: ActivityTier
  nextRunAt: Date
  priority: number
}

/**
 * Schedule a batch of traders with appropriate intervals
 */
export function scheduleTraderBatch(
  traders: TraderActivity[],
  baseTime: Date = new Date()
): ScheduledJob[] {
  const jobs: ScheduledJob[] = []
  const tierCounts: Record<ActivityTier, number> = {
    hot: 0,
    active: 0,
    normal: 0,
    dormant: 0,
  }

  for (const trader of traders) {
    const tier = classifyActivityTier(trader)
    const schedule = TIER_SCHEDULES[tier]
    tierCounts[tier]++

    // Stagger jobs within the same tier to spread load
    const staggerMs = tierCounts[tier] * 1000 // 1 second stagger per trader
    const nextRunAt = new Date(baseTime.getTime() + schedule.intervalMinutes * 60000 + staggerMs)

    jobs.push({
      traderId: trader.traderId,
      platform: trader.platform,
      tier,
      nextRunAt,
      priority: schedule.priority,
    })
  }

  // Sort by priority (ascending) then nextRunAt
  jobs.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }
    return a.nextRunAt.getTime() - b.nextRunAt.getTime()
  })

  schedulerLogger.info(
    `Scheduled ${traders.length} traders: ${tierCounts.hot} hot, ${tierCounts.active} active, ${tierCounts.normal} normal, ${tierCounts.dormant} dormant`
  )

  return jobs
}

// ============================================
// Schedule Helpers
// ============================================

/**
 * Check if a trader should be refreshed based on last update time
 */
export function shouldRefresh(
  lastUpdatedAt: Date | null,
  tier: ActivityTier,
  now: Date = new Date()
): boolean {
  if (!lastUpdatedAt) return true

  const schedule = TIER_SCHEDULES[tier]
  const msSinceUpdate = now.getTime() - lastUpdatedAt.getTime()
  const msInterval = schedule.intervalMinutes * 60000

  return msSinceUpdate >= msInterval
}

/**
 * Get next scheduled time for a trader
 */
export function getNextScheduledTime(
  lastUpdatedAt: Date | null,
  tier: ActivityTier,
  now: Date = new Date()
): Date {
  const schedule = TIER_SCHEDULES[tier]
  const intervalMs = schedule.intervalMinutes * 60000

  if (!lastUpdatedAt) {
    return now
  }

  const nextTime = new Date(lastUpdatedAt.getTime() + intervalMs)
  return nextTime > now ? nextTime : now
}

/**
 * Get tier statistics for monitoring
 */
export function getTierStats(traders: TraderActivity[]): Record<ActivityTier, number> {
  const stats: Record<ActivityTier, number> = {
    hot: 0,
    active: 0,
    normal: 0,
    dormant: 0,
  }

  for (const trader of traders) {
    const tier = classifyActivityTier(trader)
    stats[tier]++
  }

  return stats
}
