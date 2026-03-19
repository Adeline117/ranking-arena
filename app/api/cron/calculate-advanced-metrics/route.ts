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
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  calculateSortinoRatio,
  calculateCalmarRatio,
  calculateVolatility,
  calculateDownsideVolatility,
} from '@/lib/utils/advanced-metrics'
import { calculateArenaScoreV3Legacy, type Period } from '@/lib/utils/arena-score'
import { logger } from '@/lib/logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 50

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

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

    const { data: tradersResult, error: fetchError } = await supabase
      .from('trader_snapshots_v2')
      .select('id, platform, trader_key, window, roi_pct, pnl_usd, max_drawdown, win_rate')
      .or('sortino_ratio.is.null,arena_score.is.null')
      .not('roi_pct', 'is', null)
      .order('as_of_ts', { ascending: false })
      .limit(BATCH_SIZE * 3)

    if (fetchError) {
      // If columns don't exist yet, fall back to simpler query
      if (fetchError.message?.includes('sortino_ratio') || fetchError.message?.includes('arena_score') || fetchError.code === '42703') {
        logger.warn('Advanced metric columns not found, using fallback query', {})
        const { data: fallback, error: fallbackError } = await supabase
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
    const processingMap = new Map<string, typeof traders[0][]>()

    // Group by trader
    for (const trader of traders || []) {
      const key = `${trader.platform}_${trader.trader_key}`
      if (!processingMap.has(key)) {
        processingMap.set(key, [])
      }
      processingMap.get(key)!.push(trader)
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

          // Fetch real daily returns from trader_daily_snapshots
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - periodDays)

          let dailyReturns: number[] = []
          try {
            const { data: dailySnapshots } = await supabase
              .from('trader_daily_snapshots')
              .select('date, daily_return_pct')
              .eq('platform', snapshot.platform)
              .eq('trader_key', snapshot.trader_key)
              .gte('date', startDate.toISOString().split('T')[0])
              .order('date', { ascending: true })

            dailyReturns = dailySnapshots
              ?.map(s => parseFloat(s.daily_return_pct || '0'))
              .filter(r => !isNaN(r)) || []
          } catch {
            // Table may not exist yet - use empty returns
          }

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

          // Calculate Arena Score V3
          const v3Result = calculateArenaScoreV3Legacy({
            roi,
            pnl,
            maxDrawdown,
            winRate,
            alpha: null,
            sortinoRatio,
            calmarRatio,
            maxConsecutiveWins: null,
            maxConsecutiveLosses: null,
          }, window)

          // Update snapshot - handle missing columns gracefully
          const updatePayload: Record<string, unknown> = {
            sortino_ratio: sortinoRatio,
            calmar_ratio: calmarRatio,
            volatility_pct: volatilityPct,
            downside_volatility_pct: downsideVolatilityPct,
            arena_score: v3Result.totalScore,
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
            if (v3Result.totalScore !== null) minimalPayload.arena_score = v3Result.totalScore

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

    const plog = await PipelineLogger.start('calculate-advanced-metrics')
    if (errors > 0) {
      await plog.error(new Error(`${errors} errors in ${processed} processed`), { updated, errors })
    } else {
      await plog.success(updated, { processed })
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
    const plog = await PipelineLogger.start('calculate-advanced-metrics')
    await plog.error(err)
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
