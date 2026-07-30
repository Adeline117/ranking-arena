/**
 * POST /api/cron/fetch-funding-rates
 *
 * Fetches funding rates from multiple exchanges for market sentiment analysis.
 * Funding rates indicate whether traders are predominantly long or short.
 *
 * Data sources: Binance, Bybit, OKX, Bitget public APIs
 * Schedule: Every 4 hours (funding rates update every 8 hours)
 * Priority: Medium
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const RATE_LIMIT_DELAY = 200 // 200ms between requests
const UPSTREAM_TIMEOUT_MS = 12_000
const DATABASE_TIMEOUT_MS = 12_000
const JOB_BUDGET_MS = 240_000
const MAX_FUNDING_AGE_MS = 3 * 24 * 60 * 60 * 1000
const MAX_FUNDING_FUTURE_MS = 24 * 60 * 60 * 1000
const MAX_ABSOLUTE_FUNDING_RATE = 1

interface ExchangeConfig {
  name: string
  url: string
  symbols: string[]
  responseMapper: (data: Record<string, unknown>, symbol: string) => FundingRateData[]
}

interface FundingRateData {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

interface FundingFailure {
  stage: 'upstream' | 'validation' | 'database' | 'budget'
  exchange: string
  symbol: string
  error: string
}

// ============================================
// Symbol universe
// ============================================

// Mainstream coin universe, aligned with fetch-open-interest. Kept to ~20 majors so
// symbols×exchanges stays within maxDuration=300. Absent symbols yield HTTP 400 →
// logged warn → [] (no crash).
const MAINSTREAM_COINS = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'ADA',
  'DOGE',
  'LINK',
  'DOT',
  'AVAX',
  'ARB',
  'OP',
  'LTC',
  'TRX',
  'NEAR',
  'APT',
  'SUI',
  'TON',
  'UNI',
  'ATOM',
] as const

// binance / bybit / bitget use BASEUSDT; okx uses BASE-USDT-SWAP
const USDT_SYMBOLS = MAINSTREAM_COINS.map((c) => `${c}USDT`)
const OKX_SWAP_SYMBOLS = MAINSTREAM_COINS.map((c) => `${c}-USDT-SWAP`)

// ============================================
// Exchange Configurations
// ============================================

const EXCHANGES: ExchangeConfig[] = [
  {
    name: 'binance',
    url: 'https://fapi.binance.com/fapi/v1/fundingRate',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      // Binance returns array of historical rates, take the most recent
      if (!Array.isArray(data) || data.length === 0) return []
      const latest = data[data.length - 1] as Record<string, string | number>
      return [
        {
          platform: 'binance',
          symbol,
          funding_rate: parseFloat(String(latest.fundingRate)),
          funding_time: new Date(Number(latest.fundingTime)).toISOString(),
        },
      ]
    },
  },
  {
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/funding/history',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, _symbol: string) => {
      const result = data.result as { list?: Array<Record<string, string>> } | undefined
      if (!result?.list || result.list.length === 0) return []
      const latest = result.list[0]
      return [
        {
          platform: 'bybit',
          symbol: latest.symbol,
          funding_rate: parseFloat(latest.fundingRate),
          funding_time: new Date(parseInt(latest.fundingRateTimestamp)).toISOString(),
        },
      ]
    },
  },
  {
    name: 'okx',
    url: 'https://www.okx.com/api/v5/public/funding-rate',
    symbols: OKX_SWAP_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, _symbol: string) => {
      const items = data.data as Array<Record<string, string>> | undefined
      if (!items || items.length === 0) return []
      const latest = items[0]
      return [
        {
          platform: 'okx',
          symbol: latest.instId,
          funding_rate: parseFloat(latest.fundingRate),
          funding_time: new Date(parseInt(latest.fundingTime)).toISOString(),
        },
      ]
    },
  },
  {
    name: 'bitget',
    url: 'https://api.bitget.com/api/v2/mix/market/current-fund-rate',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      // Bitget v2 current-fund-rate returns `data` as an ARRAY: [{ symbol,
      // fundingRate, fundingRateInterval, nextUpdate, ... }]. The old code read it
      // as an object (`d.fundingRate`) and referenced a non-existent `d.fundingTime`
      // → always undefined → returned [] → bitget had 0 rows in the table (silent).
      // There is no "current funding time" field; `nextUpdate` is the next settlement
      // timestamp this rate applies to → use it as funding_time (settlement moment).
      const d = (data.data as Array<Record<string, string>> | undefined)?.[0]
      if (!d || !d.fundingRate) return []
      const settlement = d.nextUpdate ? parseInt(d.nextUpdate) : NaN
      return [
        {
          platform: 'bitget',
          symbol: d.symbol || symbol,
          funding_rate: parseFloat(d.fundingRate),
          funding_time: (Number.isNaN(settlement)
            ? new Date()
            : new Date(settlement)
          ).toISOString(),
        },
      ]
    },
  },
]

// ============================================
// Helper Functions
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function remainingTimeout(deadlineMs: number, maximumMs: number): number {
  return Math.max(1, Math.min(maximumMs, deadlineMs - Date.now()))
}

function validateFundingRates(
  rates: FundingRateData[],
  exchange: string,
  symbol: string,
  nowMs = Date.now()
): FundingRateData[] {
  if (rates.length === 0) {
    throw Object.assign(new Error('upstream payload contained no funding rate'), {
      stage: 'validation' as const,
    })
  }

  return rates.map((rate) => {
    const fundingTimeMs = Date.parse(rate.funding_time)
    if (
      rate.platform !== exchange ||
      typeof rate.symbol !== 'string' ||
      rate.symbol.length === 0 ||
      !Number.isFinite(rate.funding_rate) ||
      Math.abs(rate.funding_rate) > MAX_ABSOLUTE_FUNDING_RATE ||
      !Number.isFinite(fundingTimeMs) ||
      fundingTimeMs < nowMs - MAX_FUNDING_AGE_MS ||
      fundingTimeMs > nowMs + MAX_FUNDING_FUTURE_MS
    ) {
      throw Object.assign(new Error(`invalid funding rate payload for ${exchange}/${symbol}`), {
        stage: 'validation' as const,
      })
    }

    return rate
  })
}

async function fetchFundingRate(
  exchange: ExchangeConfig,
  symbol: string,
  deadlineMs: number
): Promise<FundingRateData[]> {
  let url = exchange.url

  // Build query string based on exchange
  switch (exchange.name) {
    case 'binance':
      url += `?symbol=${symbol}&limit=1`
      break
    case 'bybit':
      url += `?category=linear&symbol=${symbol}&limit=1`
      break
    case 'okx':
      url += `?instId=${symbol}`
      break
    case 'bitget':
      url += `?symbol=${symbol}&productType=usdt-futures`
      break
  }

  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RankingArena/1.0',
    },
    signal: AbortSignal.timeout(remainingTimeout(deadlineMs, UPSTREAM_TIMEOUT_MS)),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const data = await response.json()
  return validateFundingRates(exchange.responseMapper(data, symbol), exchange.name, symbol)
}

// ============================================
// Main Handler
// ============================================

export async function POST(request: NextRequest) {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const startTime = Date.now()
  const deadlineMs = startTime + JOB_BUDGET_MS
  let fetched = 0
  let inserted = 0
  let attempted = 0
  let upstreamSucceeded = 0
  const failures: FundingFailure[] = []
  const plog = await PipelineLogger.start('fetch-funding-rates')

  try {
    exchangeLoop: for (const exchange of EXCHANGES) {
      for (const symbol of exchange.symbols) {
        if (Date.now() >= deadlineMs) {
          failures.push({
            stage: 'budget',
            exchange: exchange.name,
            symbol,
            error: `job budget exhausted after ${JOB_BUDGET_MS}ms`,
          })
          break exchangeLoop
        }

        attempted++
        try {
          const rates = await fetchFundingRate(exchange, symbol, deadlineMs)
          upstreamSucceeded++
          fetched += rates.length

          for (const rate of rates) {
            try {
              const { error } = await supabase
                .from('funding_rates')
                .upsert(
                  {
                    platform: rate.platform,
                    symbol: rate.symbol,
                    funding_rate: rate.funding_rate,
                    funding_time: rate.funding_time,
                  },
                  {
                    onConflict: 'platform,symbol,funding_time',
                  }
                )
                .abortSignal(AbortSignal.timeout(remainingTimeout(deadlineMs, DATABASE_TIMEOUT_MS)))

              if (error) {
                failures.push({
                  stage: 'database',
                  exchange: exchange.name,
                  symbol,
                  error: error.message || String(error),
                })
                logger.dbError('insert-funding-rate', error, { rate })
              } else {
                inserted++
              }
            } catch (error) {
              const message = errorMessage(error)
              failures.push({
                stage: 'database',
                exchange: exchange.name,
                symbol,
                error: message,
              })
              logger.dbError('insert-funding-rate', error, { rate })
            }
          }
        } catch (error) {
          const stage =
            error && typeof error === 'object' && 'stage' in error
              ? (error.stage as FundingFailure['stage'])
              : 'upstream'
          const message = errorMessage(error)
          failures.push({ stage, exchange: exchange.name, symbol, error: message })
          logger.warn(`[funding] ${exchange.name} ${symbol}: ${message}`)
        } finally {
          await sleep(RATE_LIMIT_DELAY)
        }
      }
    }

    const duration = Date.now() - startTime
    const expected = EXCHANGES.reduce((total, exchange) => total + exchange.symbols.length, 0)
    const acknowledgement = {
      expected,
      attempted,
      upstream_succeeded: upstreamSucceeded,
      fetched,
      inserted,
      durable_writes: inserted,
      unattempted: expected - attempted,
      failures,
    }
    const noDurableWrites = inserted === 0
    const partial =
      !noDurableWrites &&
      (attempted < expected ||
        upstreamSucceeded < expected ||
        inserted < fetched ||
        failures.length > 0)
    const status = noDurableWrites ? 'failed' : partial ? 'partial' : 'success'
    const success = status === 'success'

    if (success) {
      await plog.success(inserted, { status, acknowledgement, duration })
    } else if (partial) {
      await plog.partialSuccess(
        inserted,
        failures.map((failure) => `${failure.exchange}/${failure.symbol}:${failure.stage}`),
        { status, acknowledgement, duration }
      )
    } else {
      await plog.error(new Error('funding rate job produced no durable writes'), {
        status,
        acknowledgement,
        duration,
      })
    }

    return NextResponse.json(
      {
        success,
        status,
        fetched,
        inserted,
        errors: failures.length,
        acknowledgement,
        exchanges: EXCHANGES.length,
        duration: `${duration}ms`,
      },
      { status: noDurableWrites ? 503 : partial ? 207 : 200 }
    )
  } catch (error) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    logger.apiError('/api/cron/fetch-funding-rates', error, {})
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
        fetched,
        inserted,
        errors: failures.length,
        failures,
      },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
