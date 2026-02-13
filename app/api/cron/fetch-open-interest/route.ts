/**
 * POST /api/cron/fetch-open-interest
 *
 * Fetches open interest data from multiple exchanges.
 * Open interest indicates total outstanding positions and market activity.
 *
 * Data sources: Binance, Bybit, OKX, Bitget public APIs
 * Schedule: Every hour
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
  responseMapper: (data: any, symbol: string) => OpenInterestData | null
}

interface OpenInterestData {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_qty?: number
  timestamp: string
}

// ============================================
// Exchange Configurations
// ============================================

const EXCHANGES: ExchangeConfig[] = [
  {
    name: 'binance',
    url: 'https://fapi.binance.com/fapi/v1/openInterest',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    responseMapper: (data: any, symbol: string) => {
      if (!data || !data.openInterest) return null
      return {
        platform: 'binance',
        symbol: data.symbol || symbol,
        open_interest_usd: parseFloat(data.openInterest) * parseFloat(data.price || 0), // Approximate USD value
        open_interest_qty: parseFloat(data.openInterest),
        timestamp: new Date().toISOString(),
      }
    },
  },
  {
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/open-interest',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.result?.list || data.result.list.length === 0) return null
      const oi = data.result.list[0]
      return {
        platform: 'bybit',
        symbol: oi.symbol || symbol,
        open_interest_usd: parseFloat(oi.openInterest),
        timestamp: new Date(parseInt(oi.timestamp)).toISOString(),
      }
    },
  },
  {
    name: 'okx',
    url: 'https://www.okx.com/api/v5/public/open-interest',
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.data || data.data.length === 0) return null
      const oi = data.data[0]
      return {
        platform: 'okx',
        symbol: oi.instId || symbol,
        open_interest_usd: parseFloat(oi.oiCcy), // Already in USD
        timestamp: new Date(parseInt(oi.ts)).toISOString(),
      }
    },
  },
  {
    name: 'bitget',
    url: 'https://api.bitget.com/api/v2/mix/market/open-interest',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    responseMapper: (data: any, symbol: string) => {
      if (!data.data || !data.data.openInterest) return null
      return {
        platform: 'bitget',
        symbol: data.data.symbol || symbol,
        open_interest_usd: parseFloat(data.data.openInterestUsd || data.data.openInterest),
        open_interest_qty: parseFloat(data.data.openInterest),
        timestamp: new Date().toISOString(),
      }
    },
  },
]

// ============================================
// Helper Functions
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchOpenInterest(
  exchange: ExchangeConfig,
  symbol: string
): Promise<OpenInterestData | null> {
  try {
    let url = exchange.url

    // Build query string based on exchange
    switch (exchange.name) {
      case 'binance':
        url += `?symbol=${symbol}`
        break
      case 'bybit':
        url += `?category=linear&symbol=${symbol}&intervalTime=1h`
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
      `Failed to fetch open interest from ${exchange.name}`,
      { symbol },
      error instanceof Error ? error : new Error(String(error))
    )
    return null
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
          // Fetch open interest
          const oi = await fetchOpenInterest(exchange, symbol)

          if (oi) {
            // Insert into database
            const { error } = await supabase
              .from('open_interest')
              .upsert({
                platform: oi.platform,
                symbol: oi.symbol,
                open_interest_usd: oi.open_interest_usd,
                open_interest_contracts: oi.open_interest_qty ?? null,
                timestamp: oi.timestamp,
              }, { onConflict: 'platform,symbol,timestamp' })

            if (error) {
              // Log locally but don't send to Sentry — these are expected DB conflicts
              console.warn(`[OI] DB error for ${oi.platform}/${oi.symbol}: ${error.message || JSON.stringify(error)}`)
              errors++
            } else {
              inserted++
            }

            fetched++
          }

          // Rate limiting
          await sleep(RATE_LIMIT_DELAY)
        } catch (error) {
          logger.error(
            'Error processing open interest',
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
    logger.apiError('/api/cron/fetch-open-interest', error, {})
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
