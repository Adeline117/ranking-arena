/**
 * Calculate Activity Tiers Cron Job
 *
 * GET /api/cron/calculate-tiers - Recalculate trader activity tiers
 *
 * Schedule: Every 15 minutes (Vercel Cron)
 *
 * Purpose:
 * - Fetch all active traders with recent metrics
 * - Classify into activity tiers (hot, active, normal, dormant)
 * - Update trader_sources with tier and scheduling information
 * - Enable intelligent refresh scheduling
 */

import { NextResponse } from 'next/server'
import { isAuthorized, createSupabaseAdmin, logCronExecution } from '@/lib/cron/utils'
import { createScheduleManager } from '@/lib/services/schedule-manager'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('CalculateTiers')

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // 60 seconds timeout

/**
 * Check if smart scheduler is enabled
 */
function isSmartSchedulerEnabled(): boolean {
  return process.env.ENABLE_SMART_SCHEDULER === 'true'
}

/**
 * GET - Calculate and update trader activity tiers
 */
export async function GET(req: Request) {
  const startTime = Date.now()

  try {
    // 1. Verify authorization
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Check if smart scheduler is enabled
    if (!isSmartSchedulerEnabled()) {
      return NextResponse.json({
        ok: true,
        message: 'Smart scheduler is disabled',
        enabled: false,
        hint: 'Set ENABLE_SMART_SCHEDULER=true to enable',
      })
    }

    // 3. Create schedule manager
    const scheduleManager = createScheduleManager()

    // 4. Classify all traders
    logger.info('Starting tier classification')
    const schedules = await scheduleManager.classifyTraders()

    // 5. Update schedules in database
    logger.info(`Updating ${schedules.length} trader schedules`)
    await scheduleManager.updateSchedules(schedules)

    // 6. Get tier statistics
    const tierStats = await scheduleManager.getTierStats()

    const duration = Date.now() - startTime

    // 7. Log execution
    const supabase = createSupabaseAdmin()
    await logCronExecution(supabase, 'calculate-tiers', [
      {
        name: 'calculate-tiers',
        success: true,
        output: JSON.stringify({
          totalTraders: tierStats.total,
          tierDistribution: {
            hot: tierStats.hot,
            active: tierStats.active,
            normal: tierStats.normal,
            dormant: tierStats.dormant,
          },
        }),
        duration,
      },
    ])

    logger.info('Tier calculation complete', {
      total: tierStats.total,
      hot: tierStats.hot,
      active: tierStats.active,
      normal: tierStats.normal,
      dormant: tierStats.dormant,
      duration: `${duration}ms`,
    })

    // 8. Calculate expected API call reduction
    const expectedCallsPerDay = calculateExpectedCalls(tierStats)
    const currentCallsPerDay = tierStats.total * 6 // Assuming every 4 hours = 6x per day
    const reduction = ((currentCallsPerDay - expectedCallsPerDay) / currentCallsPerDay) * 100

    // 9. Return results
    return NextResponse.json({
      ok: true,
      ran_at: new Date().toISOString(),
      duration: `${duration}ms`,
      summary: {
        totalTraders: tierStats.total,
        tierDistribution: {
          hot: tierStats.hot,
          active: tierStats.active,
          normal: tierStats.normal,
          dormant: tierStats.dormant,
        },
        percentages: {
          hot: ((tierStats.hot / tierStats.total) * 100).toFixed(2) + '%',
          active: ((tierStats.active / tierStats.total) * 100).toFixed(2) + '%',
          normal: ((tierStats.normal / tierStats.total) * 100).toFixed(2) + '%',
          dormant: ((tierStats.dormant / tierStats.total) * 100).toFixed(2) + '%',
        },
      },
      apiEfficiency: {
        expectedCallsPerDay,
        currentCallsPerDay,
        reduction: `${reduction.toFixed(1)}%`,
        estimatedMonthlySavings: `$${Math.round((reduction / 100) * 27690)}`,
      },
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Tier calculation failed', { error: errorMessage })

    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
        hint: 'Check that smart scheduler migration has been applied',
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
  // Calls per day = (count * refreshes_per_day)
  // hot: 15min interval = 96 times/day
  // active: 60min interval = 24 times/day
  // normal: 4h interval = 6 times/day
  // dormant: 24h interval = 1 time/day

  return (
    stats.hot * 96 +
    stats.active * 24 +
    stats.normal * 6 +
    stats.dormant * 1
  )
}
