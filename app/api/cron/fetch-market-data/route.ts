/**
 * POST /api/cron/fetch-market-data
 *
 * Fetches market data for correlation calculations:
 * - BTC/ETH daily prices (for beta/alpha calculation)
 * - Funding rates (market sentiment)
 * - Market conditions (bull/bear/sideways)
 *
 * Query params:
 *   type: 'prices' | 'funding' | 'all' (default: 'all')
 *
 * Schedule: Prices every 1h, Funding every 15m
 * Priority: High
 */

import { NextRequest, NextResponse } from 'next/server'
import { detectMarketCondition, detectVolatilityRegime, calculateTrendStrength } from '@/lib/utils/market-correlation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// CoinGecko API for price data (free tier)
const COINGECKO_API = 'https://api.coingecko.com/api/v3'

export async function POST(request: NextRequest) {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || 'all'
  const startTime = Date.now()
  const plog = await PipelineLogger.start('fetch-market-data', { type })

  const supabase = getSupabaseAdmin()

  const results: Record<string, unknown> = {}

  try {
    // Fetch price data
    if (type === 'prices' || type === 'all') {
      const symbols = ['bitcoin', 'ethereum']
      const priceResults: Record<string, unknown> = {}

      for (const symbol of symbols) {
        try {
          const response = await fetch(
            `${COINGECKO_API}/coins/${symbol}/market_chart?vs_currency=usd&days=1&interval=daily`,
            { headers: { 'Accept': 'application/json' } }
          )

          if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.status}`)
          }

          const data = await response.json()
          const prices = data.prices || []

          if (prices.length >= 2) {
            const latestPrice = prices[prices.length - 1][1]
            const prevPrice = prices[prices.length - 2][1]
            const dailyReturn = ((latestPrice - prevPrice) / prevPrice) * 100

            const symbolKey = symbol === 'bitcoin' ? 'BTC' : 'ETH'
            const today = new Date().toISOString().split('T')[0]

            // Upsert to market_benchmarks
            const { error } = await supabase
              .from('market_benchmarks')
              .upsert(
                { symbol: symbolKey, date: today, close_price: latestPrice, daily_return_pct: dailyReturn },
                { onConflict: 'symbol,date' }
              )

            if (error) {
              logger.dbError('save-market-price', error, { symbol: symbolKey })
            }

            priceResults[symbolKey] = { price: latestPrice, dailyReturn }
          }
        } catch (err) {
          logger.error(`Error fetching ${symbol} market data`, {}, err instanceof Error ? err : new Error(String(err)))
          priceResults[symbol] = { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      }
      results.prices = priceResults
    }

    // Update market conditions
    if (type === 'prices' || type === 'all') {
      const conditionResults: Record<string, unknown> = {}

      for (const symbol of ['BTC', 'ETH']) {
        try {
          const { data: returns } = await supabase
            .from('market_benchmarks')
            .select('daily_return_pct')
            .eq('symbol', symbol)
            .order('date', { ascending: false })
            .limit(30)

          if (!returns || returns.length < 7) continue

          const dailyReturns = (returns as { daily_return_pct: number | string | null }[])
            .map(r => parseFloat(String(r.daily_return_pct ?? 0)))
            .reverse()

          const condition = detectMarketCondition(dailyReturns)
          const volatilityRegime = detectVolatilityRegime(dailyReturns)
          const trendStrength = calculateTrendStrength(dailyReturns)

          const today = new Date().toISOString().split('T')[0]

          const { error } = await supabase
            .from('market_conditions')
            .upsert(
              { symbol, date: today, condition, volatility_regime: volatilityRegime, trend_strength: trendStrength },
              { onConflict: 'symbol,date' }
            )

          if (error) {
            logger.dbError('save-market-condition', error, { symbol })
          }

          conditionResults[symbol] = { condition, volatilityRegime, trendStrength }
        } catch (err) {
          logger.error(`Error updating ${symbol} condition`, {}, err instanceof Error ? err : new Error(String(err)))
        }
      }
      results.conditions = conditionResults
    }

    // Fetch funding rates (placeholder)
    if (type === 'funding' || type === 'all') {
      results.funding = { message: 'Funding rates fetched via exchange APIs in worker' }
    }

    // Record pipeline metrics
    fireAndForget(
      recordFetchResult(supabase, 'market_data', {
        success: true,
        durationMs: Date.now() - startTime,
        recordCount: Object.keys(results.prices || {}).length,
        metadata: { type, results },
      }),
      'Record market data fetch metrics'
    )

    await plog.success(Object.keys(results.prices || {}).length, { type, results })
    return NextResponse.json({ success: true, type, results })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.apiError('/api/cron/fetch-market-data', err, {})

    // Record error metric
    try {
      await recordFetchResult(getSupabaseAdmin(), 'market_data', {
        success: false,
        durationMs: 0,
        recordCount: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    } catch { /* ignore */ }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
