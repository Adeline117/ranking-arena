/**
 * Schedule Manager Service
 *
 * Manages trader refresh scheduling based on activity tiers.
 * Integrates with smart-scheduler to optimize API call efficiency.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  ActivityTier,
  TraderActivity,
  ScheduledJob,
  classifyActivityTier,
  scheduleTraderBatch,
  shouldRefresh,
  getNextScheduledTime,
  getTierStats,
  TIER_SCHEDULES,
} from './smart-scheduler'
import { createLogger } from '../utils/logger'

const logger = createLogger('ScheduleManager')

// ============================================
// Types
// ============================================

export interface TraderWithSchedule {
  id: string
  platform: string
  trader_key: string
  handle: string | null
  activity_tier: ActivityTier | null
  next_refresh_at: string | null
  last_refreshed_at: string | null
  refresh_priority: number | null
  // Activity data
  rank?: number
  follower_count?: number
  last_seen_at?: string
}

export interface GetTradersOptions {
  platform?: string
  limit?: number
  priorityOrder?: boolean
  includeOverdue?: boolean
  tiers?: ActivityTier[]
}

export interface TierStats {
  hot: number
  active: number
  normal: number
  dormant: number
  total: number
  lastUpdated: string
}

export interface ClassifyOptions {
  platforms?: string[]
  forceRecalculate?: boolean
}

// ============================================
// Schedule Manager Class
// ============================================

export class ScheduleManager {
  private supabase: SupabaseClient

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase
  }

  /**
   * Classify all traders into activity tiers
   */
  async classifyTraders(options: ClassifyOptions = {}): Promise<ScheduledJob[]> {
    const startTime = Date.now()
    logger.info('Starting tier classification', options)

    try {
      // 1. Fetch traders with activity data
      const traders = await this.fetchTradersWithActivity(options.platforms)
      logger.info(`Fetched ${traders.length} traders for classification`)

      // 2. Convert to TraderActivity format
      const activities: TraderActivity[] = traders.map((t) => ({
        traderId: t.trader_key,
        platform: t.platform,
        rank: t.rank,
        followers: t.follower_count,
        lastTradeAt: t.last_seen_at ? new Date(t.last_seen_at) : undefined,
        // Note: viewsLast24h not available in current schema
      }))

      // 3. Schedule using smart scheduler
      const schedules = scheduleTraderBatch(activities)

      // 4. Log statistics
      const tierCounts = getTierStats(activities)
      const duration = Date.now() - startTime
      logger.info('Tier classification complete', {
        total: traders.length,
        ...tierCounts,
        duration: `${duration}ms`,
      })

      return schedules
    } catch (error) {
      logger.error('Failed to classify traders', { error })
      throw error
    }
  }

  /**
   * Fetch traders with activity data for classification
   */
  private async fetchTradersWithActivity(platforms?: string[]): Promise<TraderWithSchedule[]> {
    let query = this.supabase
      .from('trader_sources')
      .select(
        `
        id,
        platform,
        trader_key,
        handle,
        last_seen_at,
        activity_tier,
        next_refresh_at,
        last_refreshed_at,
        refresh_priority,
        trader_profiles!inner (
          follower_count
        ),
        trader_snapshots_v2!inner (
          metrics
        )
      `
      )
      .eq('is_active', true)
      .eq('trader_snapshots_v2.window', '7D')

    if (platforms && platforms.length > 0) {
      query = query.in('platform', platforms)
    }

    const { data, error } = await query

    if (error) {
      logger.error('Failed to fetch traders with activity', { error })
      throw error
    }

    // Flatten and extract rank from metrics
    return (data || []).map((row: any) => {
      const metrics = row.trader_snapshots_v2?.[0]?.metrics || {}
      const profile = row.trader_profiles?.[0] || {}

      return {
        id: row.id,
        platform: row.platform,
        trader_key: row.trader_key,
        handle: row.handle,
        last_seen_at: row.last_seen_at,
        activity_tier: row.activity_tier,
        next_refresh_at: row.next_refresh_at,
        last_refreshed_at: row.last_refreshed_at,
        refresh_priority: row.refresh_priority,
        rank: metrics.rank ? parseInt(metrics.rank, 10) : undefined,
        follower_count: profile.follower_count,
      }
    })
  }

  /**
   * Update trader schedules in database
   */
  async updateSchedules(schedules: ScheduledJob[]): Promise<void> {
    const startTime = Date.now()
    logger.info(`Updating ${schedules.length} trader schedules`)

    try {
      // Batch update in chunks of 500
      const chunkSize = 500
      let updated = 0

      for (let i = 0; i < schedules.length; i += chunkSize) {
        const chunk = schedules.slice(i, i + chunkSize)

        // Update each trader in the chunk
        const promises = chunk.map(async (schedule) => {
          const { error } = await this.supabase
            .from('trader_sources')
            .update({
              activity_tier: schedule.tier,
              next_refresh_at: schedule.nextRunAt.toISOString(),
              refresh_priority: schedule.priority,
              tier_updated_at: new Date().toISOString(),
            })
            .eq('platform', schedule.platform)
            .eq('trader_key', schedule.traderId)

          if (error) {
            logger.error('Failed to update schedule', {
              platform: schedule.platform,
              trader_key: schedule.traderId,
              error,
            })
          } else {
            updated++
          }
        })

        await Promise.all(promises)
        logger.info(`Updated chunk ${i / chunkSize + 1} (${updated}/${schedules.length})`)
      }

      const duration = Date.now() - startTime
      logger.info(`Schedule update complete: ${updated}/${schedules.length} in ${duration}ms`)
    } catch (error) {
      logger.error('Failed to update schedules', { error })
      throw error
    }
  }

  /**
   * Get traders that need refreshing now
   */
  async getTradersToRefresh(options: GetTradersOptions = {}): Promise<TraderWithSchedule[]> {
    const {
      platform,
      limit = 500,
      priorityOrder = true,
      includeOverdue = true,
      tiers,
    } = options

    try {
      let query = this.supabase
        .from('trader_sources')
        .select(
          `
          id,
          platform,
          trader_key,
          handle,
          activity_tier,
          next_refresh_at,
          last_refreshed_at,
          refresh_priority
        `
        )
        .eq('is_active', true)

      // Filter by platform
      if (platform) {
        query = query.eq('platform', platform)
      }

      // Filter by tiers
      if (tiers && tiers.length > 0) {
        query = query.in('activity_tier', tiers)
      }

      // Filter by next_refresh_at (due now or overdue)
      if (includeOverdue) {
        query = query.lte('next_refresh_at', new Date().toISOString())
      }

      // Sort by priority
      if (priorityOrder) {
        query = query
          .order('refresh_priority', { ascending: true })
          .order('next_refresh_at', { ascending: true })
      } else {
        query = query.order('next_refresh_at', { ascending: true })
      }

      // Limit results
      query = query.limit(limit)

      const { data, error } = await query

      if (error) {
        logger.error('Failed to get traders to refresh', { error })
        throw error
      }

      logger.info(`Found ${data?.length || 0} traders to refresh`, options)
      return (data || []) as TraderWithSchedule[]
    } catch (error) {
      logger.error('Failed to get traders to refresh', { error })
      throw error
    }
  }

  /**
   * Mark traders as refreshed (update last_refreshed_at and calculate next_refresh_at)
   */
  async markRefreshed(traderIds: string[], timestamp?: Date): Promise<void> {
    const refreshTime = timestamp || new Date()
    logger.info(`Marking ${traderIds.length} traders as refreshed`)

    try {
      // Fetch current tier for each trader
      const { data: traders, error: fetchError } = await this.supabase
        .from('trader_sources')
        .select('id, activity_tier')
        .in('id', traderIds)

      if (fetchError) {
        logger.error('Failed to fetch traders for marking refreshed', { error: fetchError })
        throw fetchError
      }

      // Update each trader with calculated next_refresh_at
      const promises = (traders || []).map(async (trader) => {
        const tier = (trader.activity_tier as ActivityTier) || 'normal'
        const nextRefreshAt = getNextScheduledTime(refreshTime, tier)

        const { error } = await this.supabase
          .from('trader_sources')
          .update({
            last_refreshed_at: refreshTime.toISOString(),
            next_refresh_at: nextRefreshAt.toISOString(),
          })
          .eq('id', trader.id)

        if (error) {
          logger.error('Failed to mark trader as refreshed', {
            trader_id: trader.id,
            error,
          })
        }
      })

      await Promise.all(promises)
      logger.info(`Marked ${traderIds.length} traders as refreshed`)
    } catch (error) {
      logger.error('Failed to mark traders as refreshed', { error })
      throw error
    }
  }

  /**
   * Get tier statistics
   */
  async getTierStats(): Promise<TierStats> {
    try {
      const { data, error } = await this.supabase
        .from('trader_sources')
        .select('activity_tier')
        .eq('is_active', true)

      if (error) {
        logger.error('Failed to get tier stats', { error })
        throw error
      }

      const stats: TierStats = {
        hot: 0,
        active: 0,
        normal: 0,
        dormant: 0,
        total: 0,
        lastUpdated: new Date().toISOString(),
      }

      for (const row of data || []) {
        const tier = row.activity_tier as ActivityTier | null
        if (tier && tier in stats) {
          stats[tier]++
        }
        stats.total++
      }

      return stats
    } catch (error) {
      logger.error('Failed to get tier stats', { error })
      throw error
    }
  }

  /**
   * Get overdue traders (past their next_refresh_at)
   */
  async getOverdueTraders(platform?: string): Promise<TraderWithSchedule[]> {
    try {
      let query = this.supabase
        .from('trader_sources')
        .select(
          `
          id,
          platform,
          trader_key,
          handle,
          activity_tier,
          next_refresh_at,
          last_refreshed_at,
          refresh_priority
        `
        )
        .eq('is_active', true)
        .lt('next_refresh_at', new Date().toISOString())
        .not('next_refresh_at', 'is', null)

      if (platform) {
        query = query.eq('platform', platform)
      }

      const { data, error } = await query.order('next_refresh_at', { ascending: true })

      if (error) {
        logger.error('Failed to get overdue traders', { error })
        throw error
      }

      logger.info(`Found ${data?.length || 0} overdue traders`)
      return (data || []) as TraderWithSchedule[]
    } catch (error) {
      logger.error('Failed to get overdue traders', { error })
      throw error
    }
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a schedule manager instance with Supabase admin client
 */
export function createScheduleManager(): ScheduleManager {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error('Supabase environment variables not configured')
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  })

  return new ScheduleManager(supabase)
}
