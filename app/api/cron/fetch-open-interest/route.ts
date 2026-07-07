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
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes

const RATE_LIMIT_DELAY = 200 // 200ms between requests

interface ExchangeConfig {
  name: string
  url: string
  symbols: string[]
  responseMapper: (data: Record<string, unknown>, symbol: string) => OpenInterestData | null
  // OI endpoints on Binance/Bybit/Bitget return base-coin QUANTITY, not USD. For
  // those, fetch a price and compute open_interest_usd = qty * price. OKX returns
  // oiUsd directly, so it needs no priceUrl.
  priceUrl?: (symbol: string) => string
  priceParse?: (data: Record<string, unknown>) => number | null
}

interface OpenInterestData {
  platform: string
  symbol: string
  open_interest_usd: number
  open_interest_qty?: number
  timestamp: string
}

// ============================================
// Symbol universe
// ============================================

// Mainstream coin universe (restored from the pre-2026-02-14 24-symbol set, which
// was silently narrowed to 3-5 symbols). Kept to ~20 majors so that symbols×exchanges
// (≈80 fetches, ~2 requests each for base-coin venues) stays well within maxDuration=300.
// A symbol absent on a given venue just yields an HTTP 400 → logged warn → null (no crash).
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
    url: 'https://fapi.binance.com/fapi/v1/openInterest',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      if (!data || !data.openInterest) return null
      return {
        platform: 'binance',
        symbol: (data.symbol as string) || symbol,
        // /fapi/v1/openInterest returns only contract qty (no price) — the old
        // code multiplied by a non-existent data.price → always $0. USD is
        // computed below via priceUrl (markPrice). Leave 0 here.
        open_interest_usd: 0,
        open_interest_qty: parseFloat(data.openInterest as string),
        timestamp: new Date().toISOString(),
      }
    },
    priceUrl: (symbol) => `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
    priceParse: (d) => parseFloat((d.markPrice as string) || '0') || null,
  },
  {
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/open-interest',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      const result = data.result as { list?: Array<Record<string, string>> } | undefined
      if (!result?.list || result.list.length === 0) return null
      const oi = result.list[0]
      return {
        platform: 'bybit',
        symbol: oi.symbol || symbol,
        // Bybit v5 openInterest is base-coin qty (NOT USD) — USD via priceUrl.
        open_interest_usd: 0,
        open_interest_qty: parseFloat(oi.openInterest),
        timestamp: new Date(parseInt(oi.timestamp)).toISOString(),
      }
    },
    priceUrl: (symbol) =>
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`,
    priceParse: (d) => {
      const row = (d.result as { list?: Array<Record<string, string>> } | undefined)?.list?.[0]
      return row ? parseFloat(row.lastPrice) || null : null
    },
  },
  {
    name: 'okx',
    url: 'https://www.okx.com/api/v5/public/open-interest',
    symbols: OKX_SWAP_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      const items = data.data as Array<Record<string, string>> | undefined
      if (!items || items.length === 0) return null
      const oi = items[0]
      return {
        platform: 'okx',
        symbol: oi.instId || symbol,
        // OKX returns oiUsd (true USD value) directly; oiCcy is the base-coin
        // amount (the old code used oiCcy and mislabeled it "Already in USD").
        open_interest_usd: parseFloat(oi.oiUsd),
        open_interest_qty: parseFloat(oi.oiCcy),
        timestamp: new Date(parseInt(oi.ts)).toISOString(),
      }
    },
  },
  {
    name: 'bitget',
    url: 'https://api.bitget.com/api/v2/mix/market/open-interest',
    symbols: USDT_SYMBOLS,
    responseMapper: (data: Record<string, unknown>, symbol: string) => {
      // Actual shape: { data: { openInterestList: [{ symbol, size }] } }. The old
      // code read data.data.openInterest (does not exist) → always returned null,
      // so Bitget OI was never recorded at all.
      const row = (data.data as { openInterestList?: Array<Record<string, string>> } | undefined)
        ?.openInterestList?.[0]
      if (!row || !row.size) return null
      return {
        platform: 'bitget',
        symbol: row.symbol || symbol,
        // size is base-coin OI; USD computed via priceUrl (ticker lastPr).
        open_interest_usd: 0,
        open_interest_qty: parseFloat(row.size),
        timestamp: new Date().toISOString(),
      }
    },
    priceUrl: (symbol) =>
      `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${symbol}&productType=usdt-futures`,
    priceParse: (d) => {
      const row = (d.data as Array<Record<string, string>> | undefined)?.[0]
      return row ? parseFloat(row.lastPr) || null : null
    },
  },
]

// ============================================
// Helper Functions
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
        Accept: 'application/json',
        'User-Agent': 'RankingArena/1.0',
      },
    })

    if (!response.ok) {
      // 403/451 are expected (WAF/geo-block) — don't send to Sentry
      logger.warn(`[oi] ${exchange.name} ${symbol}: HTTP ${response.status}`)
      return null
    }

    const data = await response.json()
    const oi = exchange.responseMapper(data, symbol)

    // Base-coin exchanges (binance/bybit/bitget) report OI as a quantity, not USD.
    // Fetch the exchange's price and compute open_interest_usd = qty * price. If the
    // price fetch fails we keep usd=0 but still record the qty (no row is lost).
    if (
      oi &&
      exchange.priceUrl &&
      exchange.priceParse &&
      (!oi.open_interest_usd || oi.open_interest_usd === 0) &&
      oi.open_interest_qty
    ) {
      try {
        const pxRes = await fetch(exchange.priceUrl(symbol), {
          headers: { Accept: 'application/json', 'User-Agent': 'RankingArena/1.0' },
        })
        if (pxRes.ok) {
          const price = exchange.priceParse(await pxRes.json())
          if (price && price > 0) oi.open_interest_usd = oi.open_interest_qty * price
        }
      } catch {
        // price fetch failed — leave usd at 0; qty is still recorded
      }
    }

    return oi
  } catch (error) {
    logger.warn(
      `[oi] ${exchange.name} ${symbol}: ${error instanceof Error ? error.message : String(error)}`
    )
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
            const { error } = await supabase.from('open_interest').upsert(
              {
                platform: oi.platform,
                symbol: oi.symbol,
                open_interest_usd: oi.open_interest_usd,
                open_interest_contracts: oi.open_interest_qty ?? null,
                timestamp: oi.timestamp,
              },
              { onConflict: 'platform,symbol,timestamp' }
            )

            if (error) {
              // Log locally but don't send to Sentry — these are expected DB conflicts
              logger.warn(
                `[OI] DB error for ${oi.platform}/${oi.symbol}: ${error.message || JSON.stringify(error)}`
              )
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
