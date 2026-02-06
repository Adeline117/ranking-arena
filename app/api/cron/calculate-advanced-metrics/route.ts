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
import { createClient } from '@supabase/supabase-js'
import {
  calculateSortinoRatio,
  calculateCalmarRatio,
  calculateVolatility,
  calculateDownsideVolatility,
} from '@/lib/utils/advanced-metrics'
import { calculateArenaScoreV3, type Period } from '@/lib/utils/arena-score'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 50

export async function POST(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  let processed = 0
  let updated = 0
  let errors = 0

  try {
    // Get traders that need metrics calculation
    // Prioritize those with null advanced metrics or stale data
    const { data: traders, error: fetchError } = await supabase
      .from('trader_snapshots')
      .select('id, source, source_trader_id, window, roi, pnl, max_drawdown, win_rate')
      .or('sortino_ratio.is.null,arena_score_v3.is.null')
      .not('roi', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(BATCH_SIZE * 3) // Get more to account for different windows

    if (fetchError) throw fetchError

    // Process in batches
    const windows: Period[] = ['7D', '30D', '90D']
    const processingMap = new Map<string, typeof traders[0][]>()

    // Group by trader
    for (const trader of traders || []) {
      const key = `${trader.source}_${trader.source_trader_id}`
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
          const roi = parseFloat(snapshot.roi || '0')
          const pnl = parseFloat(snapshot.pnl || '0')
          const maxDrawdown = parseFloat(snapshot.max_drawdown || '0')
          const winRate = parseFloat(snapshot.win_rate || '0')

          // Fetch real daily returns from trader_daily_snapshots
          const startDate = new Date()
          startDate.setDate(startDate.getDate() - periodDays)

          const { data: dailySnapshots } = await supabase
            .from('trader_daily_snapshots')
            .select('date, daily_return_pct')
            .eq('platform', snapshot.source)
            .eq('trader_key', snapshot.source_trader_id)
            .gte('date', startDate.toISOString().split('T')[0])
            .order('date', { ascending: true })

          const dailyReturns = dailySnapshots
            ?.map(s => parseFloat(s.daily_return_pct || '0'))
            .filter(r => !isNaN(r)) || []

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
          const v3Result = calculateArenaScoreV3({
            roi,
            pnl,
            maxDrawdown,
            winRate,
            alpha: null, // Will be calculated by market correlation job
            sortinoRatio,
            calmarRatio,
            maxConsecutiveWins: null, // Requires trade history
            maxConsecutiveLosses: null,
          }, window)

          // Update snapshot
          const { error: updateError } = await supabase
            .from('trader_snapshots')
            .update({
              sortino_ratio: sortinoRatio,
              calmar_ratio: calmarRatio,
              volatility_pct: volatilityPct,
              downside_volatility_pct: downsideVolatilityPct,
              arena_score_v3: v3Result.totalScore,
              alpha_score: v3Result.alphaScore,
              consistency_score: v3Result.consistencyScore,
              risk_adjusted_score_v3: v3Result.riskAdjustedScore,
              metrics_quality: metricsQuality,
              metrics_data_points: dailyReturns.length,
            })
            .eq('id', snapshot.id)

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

    return NextResponse.json({
      success: true,
      processed,
      updated,
      errors,
      duration,
    })
  } catch (err) {
    logger.apiError('/api/cron/calculate-advanced-metrics', err, {})
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
function generateSyntheticReturns(totalRoi: number, days: number): number[] {
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
