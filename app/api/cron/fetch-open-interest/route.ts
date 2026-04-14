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
import { getSupabaseAdmin } from '@/lib/api'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const RATE_LIMIT_DELAY = 200 // 200ms between requests

interface ExchangeConfig {
  name: string
  url: string
  symbols: string[]
  responseMapper: (data: Record<string, unknown>, symbol: string) => OpenInterestData | null
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
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      if (!data || !data.openInterest) return null
      return {
        platform: 'binance',
        symbol: (data.symbol as string) || symbol,
        open_interest_usd: parseFloat(data.openInterest as string) * parseFloat((data.price as string) || '0'),
        open_interest_qty: parseFloat(data.openInterest as string),
        timestamp: new Date().toISOString(),
      }
    },
  },
  {
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/open-interest',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      const result = data.result as { list?: Array<Record<string, string>> } | undefined
      if (!result?.list || result.list.length === 0) return null
      const oi = result.list[0]
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
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      const items = data.data as Array<Record<string, string>> | undefined
      if (!items || items.length === 0) return null
      const oi = items[0]
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
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      const d = data.data as Record<string, string> | undefined
      if (!d || !d.openInterest) return null
      return {
        platform: 'bitget',
        symbol: d.symbol || symbol,
        open_interest_usd: parseFloat(d.openInterestUsd || d.openInterest),
        open_interest_qty: parseFloat(d.openInterest),
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
      // 403/451 are expected (WAF/geo-block) — don't send to Sentry
      logger.warn(`[oi] ${exchange.name} ${symbol}: HTTP ${response.status}`)
      return null
    }

    const data = await response.json()
    return exchange.responseMapper(data, symbol)
  } catch (error) {
    logger.warn(`[oi] ${exchange.name} ${symbol}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
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
  let fetched = 0
  let inserted = 0
  let errors = 0

  const plog = await PipelineLogger.start('fetch-open-interest')

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
              logger.warn(`[OI] DB error for ${oi.platform}/${oi.symbol}: ${error.message || JSON.stringify(error)}`)
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

    await plog.success(inserted, { fetched, errors })

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
    await plog.error(error)
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
