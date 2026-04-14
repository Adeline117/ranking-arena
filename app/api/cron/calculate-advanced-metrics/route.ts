/**
 * POST /api/cron/calculate-advanced-metrics
 *
 * Calculates advanced trading metrics for traders:
 * - Sortino Ratio, Calmar Ratio, Profit Factor, Recovery Factor
 * - Max consecutive wins/losses
 * - Volatility metrics
 * - Arena Score V3
 *
 * Schedule: Every 4 hours
 * Priority: Normal
 */

import { NextRequest, NextResponse } from 'next/server'
import { DATA_QUALITY_BOUNDARY } from '@/lib/pipeline/types'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getReadReplica } from '@/lib/supabase/read-replica'
import {
  calculateSortinoRatio,
  calculateCalmarRatio,
  calculateVolatility,
  calculateDownsideVolatility,
} from '@/lib/utils/advanced-metrics'
import type { Period } from '@/lib/utils/arena-score'
import { logger } from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 500

export async function POST(request: NextRequest) {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin() as SupabaseClient
  const readDb = getReadReplica() as SupabaseClient // Read replica for heavy analytical reads
  const plog = await PipelineLogger.start('calculate-advanced-metrics')

  const startTime = Date.now()
  let processed = 0
  let updated = 0
  let errors = 0

  try {
    // Get traders that need metrics calculation
    // Try with advanced column filter first, fall back to simpler query
    let traders: Array<{
      id: string
      platform: string
      trader_key: string
      window: string | null
      roi_pct: string | null
      pnl_usd: string | null
      max_drawdown: string | null
      win_rate: string | null
    }> | null = null

    const { data: tradersResult, error: fetchError } = await readDb
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, roi_pct, pnl_usd, max_drawdown, win_rate')
      .is('sortino_ratio', null)
      .not('roi_pct', 'is', null)
      .order('as_of_ts', { ascending: false })
      .limit(BATCH_SIZE * 3)

    if (fetchError) {
      // If columns don't exist yet, fall back to simpler query
      if (fetchError.message?.includes('sortino_ratio') || fetchError.code === '42703') {
        logger.warn('Advanced metric columns not found, using fallback query', {})
        const { data: fallback, error: fallbackError } = await readDb
          .from('trader_snapshots_v2')
          .select('id, platform, trader_key, window, roi_pct, pnl_usd, max_drawdown, win_rate')
          .not('roi_pct', 'is', null)
          .order('as_of_ts', { ascending: false })
          .limit(BATCH_SIZE * 3)

        if (fallbackError) throw fallbackError
        traders = fallback
      } else {
        throw fetchError
      }
    } else {
      traders = tradersResult
    }

    // Process in batches
    const windows: Period[] = ['7D', '30D', '90D']
    const processingMap = new Map<string, NonNullable<typeof traders>[0][]>()

    // Group by trader
    for (const trader of traders || []) {
      const key = `${trader.platform}_${trader.trader_key}`
      if (!processingMap.has(key)) {
        processingMap.set(key, [])
      }
      processingMap.get(key)!.push(trader)
    }

    // Batch-fetch equity curve data for every trader (much denser than daily_snapshots)
    // equity_curve has 812K rows vs daily_snapshots 400K, and covers 25 platforms
    const allTraderKeys = [...new Set((traders || []).map(t => t.trader_key))]
    const allPlatforms = [...new Set((traders || []).map(t => t.platform))]
    const dailySnapshotMap = new Map<string, Array<{ date: string; daily_return_pct: string | null }>>()
    try {
      // Fetch equity curve data — daily ROI points that can be diffed for daily returns
      for (let i = 0; i < allPlatforms.length; i++) {
        const platform = allPlatforms[i]
        const platformTraders = (traders || []).filter(t => t.platform === platform).map(t => t.trader_key)
        if (platformTraders.length === 0) continue

        const { data: eqRows } = await readDb
          .from('trader_equity_curve')
          .select('source_trader_id, data_date, roi_pct')
          .eq('source', platform)
          .in('source_trader_id', platformTraders)
          .order('data_date', { ascending: true })
          .limit(5000)

        if (!eqRows?.length) continue

        // Group by trader and compute daily returns from cumulative ROI
        const byTrader = new Map<string, Array<{ date: string; roi: number }>>()
        for (const row of eqRows) {
          if (row.roi_pct == null) continue
          const arr = byTrader.get(row.source_trader_id) || []
          arr.push({ date: row.data_date, roi: Number(row.roi_pct) })
          byTrader.set(row.source_trader_id, arr)
        }

        for (const [tid, points] of byTrader) {
          if (points.length < 2) continue
          const returns: Array<{ date: string; daily_return_pct: string | null }> = []
          for (let j = 1; j < points.length; j++) {
            returns.push({
              date: points[j].date,
              daily_return_pct: String(points[j].roi - points[j - 1].roi),
            })
          }
          dailySnapshotMap.set(tid, returns)
        }
      }

      // Fallback: also check trader_daily_snapshots for any traders not in equity_curve
      // DATA_QUALITY_BOUNDARY imported from lib/pipeline/types.ts
      const missingTraders = allTraderKeys.filter(k => !dailySnapshotMap.has(k))
      if (missingTraders.length > 0) {
        const earliestStart = new Date()
        earliestStart.setDate(earliestStart.getDate() - 90)
        const earliestDateStr = earliestStart.toISOString().split('T')[0]
        const { data: allDailySnaps } = await readDb
          .from('trader_daily_snapshots')
          .select('trader_key, date, daily_return_pct')
          .in('trader_key', missingTraders)
          .gte('date', earliestDateStr > DATA_QUALITY_BOUNDARY ? earliestDateStr : DATA_QUALITY_BOUNDARY)
          .order('date', { ascending: true })

        for (const row of allDailySnaps ?? []) {
          if (!dailySnapshotMap.has(row.trader_key)) {
            dailySnapshotMap.set(row.trader_key, [])
          }
          dailySnapshotMap.get(row.trader_key)!.push({ date: row.date, daily_return_pct: row.daily_return_pct })
        }
      }
    } catch (err) {
      // Tables may not exist yet — dailySnapshotMap stays empty, metrics skip gracefully
      logger.warn('[calculate-advanced-metrics] equity curve / daily snapshot fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Process each trader
    for (const [_key, snapshots] of processingMap) {
      if (processed >= BATCH_SIZE) break

      try {
        for (const snapshot of snapshots) {
          const window = snapshot.window?.toUpperCase() as Period
          if (!windows.includes(window)) continue

          // Calculate period days
          const periodDays = window === '7D' ? 7 : window === '30D' ? 30 : 90

          // For now, use simplified calculations without historical trade data
          // In production, these would be fetched from trade history
          const roi = parseFloat(snapshot.roi_pct || '0')
          const pnl = parseFloat(snapshot.pnl_usd || '0')
          const maxDrawdown = parseFloat(snapshot.max_drawdown || '0')
          const winRate = parseFloat(snapshot.win_rate || '0')

          // Resolve daily returns from the pre-fetched batch map
          // Now uses equity_curve data first (812K rows, 25 platforms)
          // with daily_snapshots as fallback
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - periodDays)
          const startDateStr = startDate.toISOString().split('T')[0]

          const traderDailyRows = dailySnapshotMap.get(snapshot.trader_key) ?? []
          const dailyReturns = traderDailyRows
            .filter(s => s.date >= startDateStr)
            .map(s => parseFloat(s.daily_return_pct || '0'))
            .filter(r => !isNaN(r))

          // Determine metrics quality based on data availability
          let metricsQuality: 'high' | 'medium' | 'low' | 'insufficient'
          const dataPointsRatio = dailyReturns.length / periodDays

          if (dataPointsRatio >= 0.9) {
            metricsQuality = 'high'
          } else if (dataPointsRatio >= 0.5) {
            metricsQuality = 'medium'
          } else if (dataPointsRatio >= 0.1) {
            metricsQuality = 'low'
          } else {
            metricsQuality = 'insufficient'
          }

          // Calculate advanced metrics only if we have sufficient data
          let sortinoRatio: number | null = null
          let calmarRatio: number | null = null
          let volatilityPct: number | null = null
          let downsideVolatilityPct: number | null = null

          if (dailyReturns.length >= 7) {
            sortinoRatio = calculateSortinoRatio(dailyReturns)
            calmarRatio = calculateCalmarRatio(roi, maxDrawdown, periodDays)
            volatilityPct = calculateVolatility(dailyReturns)
            downsideVolatilityPct = calculateDownsideVolatility(dailyReturns)
          }

          // Update snapshot with advanced metrics only
          // NOTE: arena_score is NOT written here — compute-leaderboard is the
          // single source of truth for arena_score.  Previously this cron used
          // calculateArenaScoreV3Legacy which had broken scaling factors
          // (55/70 and 12/15 assumed old V2 weights of 70/15, but V2 changed to 60/40),
          // silently corrupting arena_score in trader_snapshots_v2.
          const updatePayload: Record<string, unknown> = {
            sortino_ratio: sortinoRatio,
            calmar_ratio: calmarRatio,
            volatility_pct: volatilityPct,
            downside_volatility_pct: downsideVolatilityPct,
            metrics_quality: metricsQuality,
            metrics_data_points: dailyReturns.length,
          }

          let { error: updateError } = await supabase
            .from('trader_snapshots_v2')
            .update(updatePayload)
            .eq('id', snapshot.id)

          // If columns don't exist, try minimal update
          if (updateError && (updateError.code === '42703' || updateError.message?.includes('column'))) {
            const minimalPayload: Record<string, unknown> = {}
            // Try only columns that are likely to exist
            if (sortinoRatio !== null) minimalPayload.sortino_ratio = sortinoRatio

            if (Object.keys(minimalPayload).length > 0) {
              const { error: retryError } = await supabase
                .from('trader_snapshots_v2')
                .update(minimalPayload)
                .eq('id', snapshot.id)
              updateError = retryError
            }
          }

          if (updateError) {
            logger.dbError('update-advanced-metrics', updateError, { snapshotId: snapshot.id })
            errors++
          } else {
            updated++
          }
        }

        processed++
      } catch (err) {
        logger.error('Error processing trader in advanced metrics', {}, err instanceof Error ? err : new Error(String(err)))
        errors++
      }
    }

    const duration = Date.now() - startTime

    const failureRate = processed > 0 ? errors / processed : 0
    if (failureRate > 0.5 && errors >= 5) {
      await plog.error(new Error(`${errors} errors in ${processed} processed`), { updated, errors })
    } else {
      await plog.success(updated, { processed, errors: errors > 0 ? errors : undefined })
    }

    return NextResponse.json({
      success: true,
      processed,
      updated,
      errors,
      duration,
    })
  } catch (err) {
    logger.apiError('/api/cron/calculate-advanced-metrics', err, {})
    await plog.error(err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err)))
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

/**
 * Generate synthetic daily returns from total ROI
 * In production, use actual daily snapshots
 */
function _generateSyntheticReturns(totalRoi: number, days: number): number[] {
  if (days <= 0) return []

  const avgDailyReturn = totalRoi / days
  const returns: number[] = []

  // Add some variance around the average
  for (let i = 0; i < days; i++) {
    const variance = (Math.random() - 0.5) * Math.abs(avgDailyReturn) * 0.5
    returns.push(avgDailyReturn + variance)
  }

  return returns
}

export async function GET(request: NextRequest) {
  return POST(request)
}
