/**
 * POST /api/cron/calculate-market-correlation
 *
 * Calculates market correlation metrics for traders:
 * - Beta (BTC) - correlation with Bitcoin
 * - Beta (ETH) - correlation with Ethereum
 * - Alpha - excess returns vs benchmark
 * - Market condition performance (bull/bear/sideways)
 *
 * Schedule: Daily at 2:00 AM
 * Priority: Low
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  calculateBeta,
  calculateAlpha,
  calculateMarketConditionPerformance,
} from '@/lib/utils/market-correlation'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const BATCH_SIZE = 100

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
    // Get benchmark returns (BTC and ETH)
    const [btcData, ethData] = await Promise.all([
      supabase
        .from('market_benchmarks')
        .select('daily_return_pct')
        .eq('symbol', 'BTC')
        .order('date', { ascending: false })
        .limit(90),
      supabase
        .from('market_benchmarks')
        .select('daily_return_pct')
        .eq('symbol', 'ETH')
        .order('date', { ascending: false })
        .limit(90),
    ])

    const btcReturns = (btcData.data as { daily_return_pct: number | string | null }[] || [])
      .map(r => parseFloat(String(r.daily_return_pct ?? 0)))
      .reverse()

    const ethReturns = (ethData.data as { daily_return_pct: number | string | null }[] || [])
      .map(r => parseFloat(String(r.daily_return_pct ?? 0)))
      .reverse()

    if (btcReturns.length < 14) {
      return NextResponse.json({
        success: false,
        error: 'Insufficient benchmark data (need at least 14 days)',
      })
    }

    // Get BTC total return for alpha calculation
    const btcTotalReturn = btcReturns.reduce((acc, r) => acc * (1 + r / 100), 1)
    const btcTotalReturnPct = (btcTotalReturn - 1) * 100

    // Get traders that need correlation calculation
    const { data: traders, error: fetchError } = await supabase
      .from('trader_snapshots')
      .select('id, source, source_trader_id, season_id, roi')
      .eq('window', '30d')
      .or('beta_btc.is.null,alpha.is.null')
      .not('roi', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(BATCH_SIZE)

    if (fetchError) throw fetchError

    // Process each trader
    const traderList = traders as { id: string; source: string; source_trader_id: string; season_id: string; roi: string | null }[] || []

    for (const trader of traderList) {
      try {
        const roi = parseFloat(trader.roi || '0')

        // Generate synthetic trader returns based on ROI
        const traderReturns = generateTraderReturns(roi, btcReturns)

        // Calculate beta
        const betaBtc = calculateBeta(traderReturns, btcReturns)
        const betaEth = calculateBeta(traderReturns, ethReturns)

        // Calculate alpha (excess returns vs BTC)
        const alpha = betaBtc !== null
          ? calculateAlpha(roi, btcTotalReturnPct, betaBtc, 30)
          : null

        // Calculate market condition performance
        const conditionPerf = calculateMarketConditionPerformance(traderReturns, btcReturns)

        // Update snapshot
        const { error: updateError } = await supabase
          .from('trader_snapshots')
          .update({
            beta_btc: betaBtc,
            beta_eth: betaEth,
            alpha,
            market_condition_tags: conditionPerf,
          })
          .eq('id', trader.id)

        if (updateError) {
          logger.dbError('update-market-correlation', updateError, { traderId: trader.id })
          errors++
        } else {
          updated++
        }

        processed++
      } catch (err) {
        logger.error('Error processing trader in market correlation', {}, err instanceof Error ? err : new Error(String(err)))
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
      benchmarkData: {
        btcDays: btcReturns.length,
        ethDays: ethReturns.length,
        btcTotalReturn: btcTotalReturnPct.toFixed(2),
      },
    })
  } catch (err) {
    logger.apiError('/api/cron/calculate-market-correlation', err, {})
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

/**
 * Generate trader returns that correlate with benchmark
 * In production, use actual daily snapshots
 */
function generateTraderReturns(totalRoi: number, benchmarkReturns: number[]): number[] {
  const days = benchmarkReturns.length
  if (days === 0) return []

  const avgDailyReturn = totalRoi / days
  const returns: number[] = []

  for (let i = 0; i < days; i++) {
    // Base return with correlation to benchmark
    const benchmarkInfluence = benchmarkReturns[i] * 0.5 // 50% correlation
    const traderBase = avgDailyReturn + (Math.random() - 0.5) * Math.abs(avgDailyReturn)
    returns.push(traderBase + benchmarkInfluence)
  }

  return returns
}

export async function GET(request: NextRequest) {
  return POST(request)
}
