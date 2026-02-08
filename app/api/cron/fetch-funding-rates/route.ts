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
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const RATE_LIMIT_DELAY = 200 // 200ms between requests

interface ExchangeConfig {
  name: string
  url: string
  symbols: string[]
  responseMapper: (data: any, symbol: string) => FundingRateData[]
}

interface FundingRateData {
  platform: string
  symbol: string
  funding_rate: number
  funding_time: string
}

// ============================================
// Exchange Configurations
// ============================================

const EXCHANGES: ExchangeConfig[] = [
  {
    name: 'binance',
    url: 'https://fapi.binance.com/fapi/v1/fundingRate',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    responseMapper: (data: any[], symbol: string) => {
      // Binance returns array of historical rates, take the most recent
      if (!Array.isArray(data) || data.length === 0) return []
      const latest = data[data.length - 1]
      return [{
        platform: 'binance',
        symbol,
        funding_rate: parseFloat(latest.fundingRate),
        funding_time: new Date(latest.fundingTime).toISOString(),
      }]
    },
  },
  {
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/funding/history',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.result?.list || data.result.list.length === 0) return []
      const latest = data.result.list[0]
      return [{
        platform: 'bybit',
        symbol: latest.symbol,
        funding_rate: parseFloat(latest.fundingRate),
        funding_time: new Date(parseInt(latest.fundingRateTimestamp)).toISOString(),
      }]
    },
  },
  {
    name: 'okx',
    url: 'https://www.okx.com/api/v5/public/funding-rate',
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.data || data.data.length === 0) return []
      const latest = data.data[0]
      return [{
        platform: 'okx',
        symbol: latest.instId,
        funding_rate: parseFloat(latest.fundingRate),
        funding_time: new Date(parseInt(latest.fundingTime)).toISOString(),
      }]
    },
  },
  {
    name: 'bitget',
    url: 'https://api.bitget.com/api/v2/mix/market/current-fund-rate',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.data || !data.data.fundingRate) return []
      return [{
        platform: 'bitget',
        symbol: data.data.symbol || symbol,
        funding_rate: parseFloat(data.data.fundingRate),
        funding_time: new Date(parseInt(data.data.fundingTime)).toISOString(),
      }]
    },
  },
]

// ============================================
// Helper Functions
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchFundingRate(
  exchange: ExchangeConfig,
  symbol: string
): Promise<FundingRateData[]> {
  try {
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
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'RankingArena/1.0',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()
    return exchange.responseMapper(data, symbol)
  } catch (error) {
    logger.error(
      `Failed to fetch funding rate from ${exchange.name}`,
      { symbol },
      error instanceof Error ? error : new Error(String(error))
    )
    return []
  }
}

// ============================================
// Main Handler
// ============================================

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
  let fetched = 0
  let inserted = 0
  let errors = 0

  try {

    for (const exchange of EXCHANGES) {

      for (const symbol of exchange.symbols) {
        try {
          // Fetch funding rate
          const rates = await fetchFundingRate(exchange, symbol)

          // Insert into database
          for (const rate of rates) {
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

            if (error) {
              logger.dbError('insert-funding-rate', error, { rate })
              errors++
            } else {
              inserted++
            }
          }

          fetched += rates.length

          // Rate limiting
          await sleep(RATE_LIMIT_DELAY)
        } catch (error) {
          logger.error(
            'Error processing funding rate',
            { exchange: exchange.name, symbol },
            error instanceof Error ? error : new Error(String(error))
          )
          errors++
        }
      }
    }

    const duration = Date.now() - startTime

    return NextResponse.json({
      success: true,
      fetched,
      inserted,
      errors,
      exchanges: EXCHANGES.length,
      duration: `${duration}ms`,
    })
  } catch (error) {
    logger.apiError('/api/cron/fetch-funding-rates', error, {})
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
        fetched,
        inserted,
        errors,
      },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
