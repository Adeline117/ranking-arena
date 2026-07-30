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
 * Schedule: Prices every 4h (vercel.json); funding is a legacy no-op mode
 * Priority: High
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  detectMarketCondition,
  detectVolatilityRegime,
  calculateTrendStrength,
} from '@/lib/utils/market-correlation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// CoinGecko API for price data (free tier)
const COINGECKO_API = 'https://api.coingecko.com/api/v3'
const UPSTREAM_TIMEOUT_MS = 12_000
const MAX_PRICE_AGE_MS = 3 * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MIN_PRICE_USD = 0.00000001
const MAX_PRICE_USD = 100_000_000
const MAX_ABSOLUTE_DAILY_RETURN_PCT = 1_000
const PRICE_SYMBOLS = [
  { coinGeckoId: 'bitcoin', symbol: 'BTC' },
  { coinGeckoId: 'ethereum', symbol: 'ETH' },
] as const

type MarketDataType = 'prices' | 'funding' | 'all'

interface PriceBenchmark {
  price: number
  dailyReturn: number
  date: string
}

interface PipelineFailure {
  stage: 'upstream' | 'benchmark_write' | 'condition_read' | 'condition_write'
  symbol: string
  error: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parsePriceBenchmark(payload: unknown, nowMs = Date.now()): PriceBenchmark {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('CoinGecko payload must be an object')
  }

  const prices = (payload as { prices?: unknown }).prices
  if (!Array.isArray(prices) || prices.length < 2) {
    throw new Error('CoinGecko payload must contain at least two price points')
  }

  const previous = prices.at(-2)
  const latest = prices.at(-1)
  if (
    !Array.isArray(previous) ||
    previous.length < 2 ||
    !Array.isArray(latest) ||
    latest.length < 2
  ) {
    throw new Error('CoinGecko price points are malformed')
  }

  const previousTimestamp = Number(previous[0])
  const latestTimestamp = Number(latest[0])
  const previousPrice = Number(previous[1])
  const latestPrice = Number(latest[1])

  if (
    !Number.isFinite(previousTimestamp) ||
    !Number.isFinite(latestTimestamp) ||
    latestTimestamp <= previousTimestamp ||
    latestTimestamp < nowMs - MAX_PRICE_AGE_MS ||
    latestTimestamp > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    throw new Error('CoinGecko price timestamps are invalid or stale')
  }
  if (
    !Number.isFinite(previousPrice) ||
    !Number.isFinite(latestPrice) ||
    previousPrice < MIN_PRICE_USD ||
    latestPrice < MIN_PRICE_USD ||
    previousPrice > MAX_PRICE_USD ||
    latestPrice > MAX_PRICE_USD
  ) {
    throw new Error('CoinGecko prices are outside accepted finite bounds')
  }

  const dailyReturn = ((latestPrice - previousPrice) / previousPrice) * 100
  if (!Number.isFinite(dailyReturn) || Math.abs(dailyReturn) > MAX_ABSOLUTE_DAILY_RETURN_PCT) {
    throw new Error('CoinGecko daily return is outside accepted finite bounds')
  }

  return {
    price: latestPrice,
    dailyReturn,
    date: new Date(latestTimestamp).toISOString().slice(0, 10),
  }
}

async function fetchPriceBenchmark(coinGeckoId: string): Promise<PriceBenchmark> {
  const response = await fetch(
    `${COINGECKO_API}/coins/${coinGeckoId}/market_chart?vs_currency=usd&days=1&interval=daily`,
    {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }
  )

  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status}`)
  }

  return parsePriceBenchmark(await response.json())
}

export async function POST(request: NextRequest) {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const requestedType = searchParams.get('type') || 'all'
  if (!['prices', 'funding', 'all'].includes(requestedType)) {
    return NextResponse.json({ error: 'Invalid market data type' }, { status: 400 })
  }
  const type = requestedType as MarketDataType
  const startTime = Date.now()
  const plog = await PipelineLogger.start('fetch-market-data', { type })

  const supabase = getSupabaseAdmin()

  const results: Record<string, unknown> = {}
  const failures: PipelineFailure[] = []
  let priceWrites = 0
  let conditionWrites = 0
  let conditionSkips = 0

  try {
    // Fetch price data
    if (type === 'prices' || type === 'all') {
      const priceResults: Record<string, unknown> = {}

      for (const { coinGeckoId, symbol } of PRICE_SYMBOLS) {
        try {
          const benchmark = await fetchPriceBenchmark(coinGeckoId)
          const { error } = await supabase.from('market_benchmarks').upsert(
            {
              symbol,
              date: benchmark.date,
              close_price: benchmark.price,
              daily_return_pct: benchmark.dailyReturn,
            },
            { onConflict: 'symbol,date' }
          )

          if (error) {
            throw Object.assign(new Error(`market benchmark upsert failed: ${error.message}`), {
              stage: 'benchmark_write' as const,
            })
          }
          priceWrites++
          priceResults[symbol] = { ok: true, ...benchmark }
        } catch (err) {
          const stage =
            err && typeof err === 'object' && 'stage' in err
              ? (err.stage as PipelineFailure['stage'])
              : 'upstream'
          const message = errorMessage(err)
          failures.push({ stage, symbol, error: message })
          logger.error(
            `Error fetching ${coinGeckoId} market data`,
            { symbol, stage },
            err instanceof Error ? err : new Error(message)
          )
          priceResults[symbol] = { ok: false, stage, error: message }
        }
      }
      results.prices = priceResults
    }

    // Update market conditions
    if (type === 'prices' || type === 'all') {
      const conditionResults: Record<string, unknown> = {}

      for (const { symbol } of PRICE_SYMBOLS) {
        const priceResult = (results.prices as Record<string, { ok?: boolean; date?: string }>)[
          symbol
        ]
        if (!priceResult?.ok || typeof priceResult.date !== 'string') {
          conditionSkips++
          conditionResults[symbol] = { ok: false, status: 'skipped', reason: 'price_not_written' }
          continue
        }

        try {
          const { data: returns, error: readError } = await supabase
            .from('market_benchmarks')
            .select('daily_return_pct')
            .eq('symbol', symbol)
            .order('date', { ascending: false })
            .limit(30)

          if (readError) {
            throw Object.assign(new Error(`market benchmark query failed: ${readError.message}`), {
              stage: 'condition_read' as const,
            })
          }
          if (!returns || returns.length < 7) {
            conditionSkips++
            conditionResults[symbol] = {
              ok: true,
              status: 'skipped',
              reason: 'insufficient_history',
              samples: returns?.length ?? 0,
            }
            continue
          }

          const dailyReturns = (returns as { daily_return_pct: number | string | null }[])
            .map((r) => (r.daily_return_pct === null ? Number.NaN : Number(r.daily_return_pct)))
            .reverse()
          if (
            dailyReturns.some(
              (value) => !Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_DAILY_RETURN_PCT
            )
          ) {
            throw Object.assign(new Error('market benchmark history contains invalid returns'), {
              stage: 'condition_read' as const,
            })
          }

          const condition = detectMarketCondition(dailyReturns)
          const volatilityRegime = detectVolatilityRegime(dailyReturns)
          const trendStrength = calculateTrendStrength(dailyReturns)

          const { error } = await supabase.from('market_conditions').upsert(
            {
              symbol,
              date: priceResult.date,
              condition,
              volatility_regime: volatilityRegime,
              trend_strength: trendStrength,
            },
            { onConflict: 'symbol,date' }
          )

          if (error) {
            throw Object.assign(new Error(`market condition upsert failed: ${error.message}`), {
              stage: 'condition_write' as const,
            })
          }

          conditionWrites++
          conditionResults[symbol] = {
            ok: true,
            status: 'written',
            condition,
            volatilityRegime,
            trendStrength,
          }
        } catch (err) {
          const stage =
            err && typeof err === 'object' && 'stage' in err
              ? (err.stage as PipelineFailure['stage'])
              : 'condition_read'
          const message = errorMessage(err)
          failures.push({ stage, symbol, error: message })
          logger.error(
            `Error updating ${symbol} condition`,
            { stage },
            err instanceof Error ? err : new Error(message)
          )
          conditionResults[symbol] = { ok: false, stage, error: message }
        }
      }
      results.conditions = conditionResults
    }

    // Fetch funding rates (placeholder)
    if (type === 'funding' || type === 'all') {
      results.funding = { message: 'Funding rates fetched via exchange APIs in worker' }
    }

    const pricesExpected = type === 'prices' || type === 'all' ? PRICE_SYMBOLS.length : 0
    const durableWrites = priceWrites + conditionWrites
    const noDurablePrices = pricesExpected > 0 && priceWrites === 0
    const partial = !noDurablePrices && (priceWrites < pricesExpected || failures.length > 0)
    const status = noDurablePrices ? 'failed' : partial ? 'partial' : 'success'
    const success = status === 'success'
    const durationMs = Date.now() - startTime
    const acknowledgement = {
      prices_expected: pricesExpected,
      prices_written: priceWrites,
      conditions_written: conditionWrites,
      conditions_skipped: conditionSkips,
      durable_writes: durableWrites,
      failures,
    }

    // Record the real durable acknowledgement. Partial/no-write executions
    // are failures for freshness monitoring even when one symbol survived.
    fireAndForget(
      recordFetchResult(supabase, 'market_data', {
        success,
        durationMs,
        recordCount: durableWrites,
        error: success ? undefined : `${status}: ${failures.length} stage failure(s)`,
        metadata: { type, status, acknowledgement },
      }),
      'Record market data fetch metrics'
    )

    if (success) {
      await plog.success(durableWrites, { type, status, acknowledgement })
    } else {
      await plog.error(new Error(`market data ${status}`), { type, status, acknowledgement })
    }

    return NextResponse.json(
      { success, status, type, results, acknowledgement, durationMs },
      { status: noDurablePrices ? 503 : partial ? 207 : 200 }
    )
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.apiError('/api/cron/fetch-market-data', err, {})

    // Record error metric
    try {
      await recordFetchResult(getSupabaseAdmin(), 'market_data', {
        success: false,
        durationMs: Date.now() - startTime,
        recordCount: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    } catch {
      /* ignore */
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
