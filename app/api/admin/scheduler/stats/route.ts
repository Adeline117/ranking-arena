/**
 * Smart Scheduler Statistics API
 *
 * GET /api/admin/scheduler/stats - Get scheduler statistics and metrics
 *
 * Returns:
 * - Tier distribution
 * - API call efficiency metrics
 * - Data freshness by tier
 * - Overdue traders count
 * - Refresh queue status
 */

import { NextResponse } from 'next/server'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { env } from '@/lib/env'
import { createScheduleManager } from '@/lib/services/schedule-manager'
import { TIER_SCHEDULES } from '@/lib/services/smart-scheduler'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('SchedulerStats')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Check if smart scheduler is enabled
 */
function isSmartSchedulerEnabled(): boolean {
  return process.env.ENABLE_SMART_SCHEDULER === 'true'
}

/**
 * GET - Get scheduler statistics
 */
export async function GET(_req: Request) {
  try {
    // Security: Verify admin/cron secret
    const authHeader = _req.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    const cronSecret = env.CRON_SECRET
    const adminSecret = env.ADMIN_SECRET
    if (!token || (token !== cronSecret && token !== adminSecret)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if smart scheduler is enabled
    if (!isSmartSchedulerEnabled()) {
      return NextResponse.json({
        ok: false,
        enabled: false,
        message: 'Smart scheduler is not enabled',
        hint: 'Set ENABLE_SMART_SCHEDULER=true to enable',
      })
    }

    const supabase = createSupabaseAdmin()
    if (!supabase) {
      return NextResponse.json({ ok: false, error: 'Database connection failed' }, { status: 500 })
    }
    const scheduleManager = createScheduleManager()

    // 1. Get tier statistics
    const tierStats = await scheduleManager.getTierStats()

    // 2. Get overdue traders
    const overdueTraders = await scheduleManager.getOverdueTraders()

    // 3. Calculate API call efficiency
    const expectedCallsPerDay = calculateExpectedCalls(tierStats)
    const currentCallsPerDay = tierStats.total * 6 // Every 4 hours = 6x per day
    const reduction = ((currentCallsPerDay - expectedCallsPerDay) / currentCallsPerDay) * 100
    const costSavingsPerMonth = Math.round((reduction / 100) * 27690)

    // 4. Query refresh queue from database views
    const { data: queueData, error: queueError } = await supabase
      .from('v_scheduler_refresh_queue')
      .select('platform, market_type, trader_key, activity_tier, next_refresh_at, last_refreshed_at, priority_score')

    if (queueError) {
      logger.error('Failed to query refresh queue', { error: queueError })
    }

    // 5. Calculate data freshness by tier
    const { data: _freshnessData, error: freshnessError } = await supabase.rpc(
      'calculate_freshness_by_tier'
    )

    if (freshnessError) {
      logger.warn('Failed to calculate freshness', { error: freshnessError })
    }

    // 6. Get recent tier updates
    const { data: recentUpdates, error: _updatesError } = await supabase
      .from('trader_sources')
      .select('tier_updated_at')
      .eq('is_active', true)
      .not('tier_updated_at', 'is', null)
      .order('tier_updated_at', { ascending: false })
      .limit(1)
      .single()

    const lastTierUpdate = recentUpdates?.tier_updated_at || null

    // 7. Return comprehensive statistics
    return NextResponse.json({
      ok: true,
      enabled: true,
      timestamp: new Date().toISOString(),
      tierDistribution: {
        hot: {
          count: tierStats.hot,
          percentage: ((tierStats.hot / tierStats.total) * 100).toFixed(2) + '%',
          refreshInterval: `${TIER_SCHEDULES.hot.intervalMinutes} minutes`,
          refreshesPerDay: 96,
        },
        active: {
          count: tierStats.active,
          percentage: ((tierStats.active / tierStats.total) * 100).toFixed(2) + '%',
          refreshInterval: `${TIER_SCHEDULES.active.intervalMinutes} minutes`,
          refreshesPerDay: 24,
        },
        normal: {
          count: tierStats.normal,
          percentage: ((tierStats.normal / tierStats.total) * 100).toFixed(2) + '%',
          refreshInterval: `${TIER_SCHEDULES.normal.intervalMinutes} minutes`,
          refreshesPerDay: 6,
        },
        dormant: {
          count: tierStats.dormant,
          percentage: ((tierStats.dormant / tierStats.total) * 100).toFixed(2) + '%',
          refreshInterval: `${TIER_SCHEDULES.dormant.intervalMinutes} minutes`,
          refreshesPerDay: 1,
        },
        total: tierStats.total,
      },
      apiEfficiency: {
        currentSystem: {
          callsPerDay: currentCallsPerDay,
          description: 'All traders updated every 4 hours',
        },
        smartScheduler: {
          callsPerDay: expectedCallsPerDay,
          description: 'Tier-based refresh scheduling',
        },
        reduction: {
          percentage: `${reduction.toFixed(1)}%`,
          callsSaved: currentCallsPerDay - expectedCallsPerDay,
        },
        costSavings: {
          perDay: `$${Math.round(costSavingsPerMonth / 30)}`,
          perMonth: `$${costSavingsPerMonth}`,
          perYear: `$${costSavingsPerMonth * 12}`,
        },
      },
      dataFreshness: {
        lastTierUpdate,
        overdueTraders: overdueTraders.length,
        overdueByTier: getOverdueByTier(overdueTraders),
      },
      refreshQueue: queueData || [],
      configuration: {
        tierRecalculationInterval: process.env.SMART_SCHEDULER_TIER_RECALC_MINUTES || '15',
        maxBatchSize: process.env.SMART_SCHEDULER_MAX_BATCH_SIZE || '500',
        staggerDelay: process.env.SMART_SCHEDULER_STAGGER_MS || '1000',
        thresholds: {
          hot: {
            rank: process.env.SMART_SCHEDULER_HOT_RANK_THRESHOLD || '100',
            followers: process.env.SMART_SCHEDULER_HOT_FOLLOWERS_THRESHOLD || '10000',
            views: process.env.SMART_SCHEDULER_HOT_VIEWS_THRESHOLD || '1000',
          },
          active: {
            rank: process.env.SMART_SCHEDULER_ACTIVE_RANK_THRESHOLD || '500',
            followers: process.env.SMART_SCHEDULER_ACTIVE_FOLLOWERS_THRESHOLD || '1000',
          },
          normal: {
            rank: process.env.SMART_SCHEDULER_NORMAL_RANK_THRESHOLD || '2000',
          },
        },
      },
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Failed to get scheduler stats', { error: errorMessage })

    return NextResponse.json(
      {
        ok: false,
        error: 'Failed to get scheduler stats',
        code: 'INTERNAL_ERROR',
      },
      { status: 500 }
    )
  }
}

/**
 * Calculate expected API calls per day based on tier distribution
 */
function calculateExpectedCalls(stats: {
  hot: number
  active: number
  normal: number
  dormant: number
}): number {
  return stats.hot * 96 + stats.active * 24 + stats.normal * 6 + stats.dormant * 1
}

/**
 * Group overdue traders by tier
 */
function getOverdueByTier(overdueTraders: Array<{ activity_tier: string | null }>): Record<
  string,
  number
> {
  const result: Record<string, number> = {
    hot: 0,
    active: 0,
    normal: 0,
    dormant: 0,
    unknown: 0,
  }

  for (const trader of overdueTraders) {
    const tier = trader.activity_tier || 'unknown'
    result[tier] = (result[tier] || 0) + 1
  }

  return result
}
