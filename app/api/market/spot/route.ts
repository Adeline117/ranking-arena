/**
 * GET /api/market/spot
 * Fetches top coins from CoinGecko /coins/markets with tiered caching (memory → Redis).
 * Fallback chain: CoinGecko → Binance public ticker API
 */
import { NextRequest, NextResponse } from 'next/server'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { CoinGeckoMarketsResponseSchema, validateCoinGeckoResponse } from './schemas'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const logger = createLogger('market-spot')

// Top 25 coins by market cap with Binance symbol mapping
const BINANCE_SYMBOLS = [
  { symbol: 'BTC', binance: 'BTCUSDT', id: 'bitcoin', name: 'Bitcoin' },
  { symbol: 'ETH', binance: 'ETHUSDT', id: 'ethereum', name: 'Ethereum' },
  { symbol: 'BNB', binance: 'BNBUSDT', id: 'binancecoin', name: 'BNB' },
  { symbol: 'SOL', binance: 'SOLUSDT', id: 'solana', name: 'Solana' },
  { symbol: 'XRP', binance: 'XRPUSDT', id: 'ripple', name: 'XRP' },
  { symbol: 'DOGE', binance: 'DOGEUSDT', id: 'dogecoin', name: 'Dogecoin' },
  { symbol: 'ADA', binance: 'ADAUSDT', id: 'cardano', name: 'Cardano' },
  { symbol: 'AVAX', binance: 'AVAXUSDT', id: 'avalanche-2', name: 'Avalanche' },
  { symbol: 'TRX', binance: 'TRXUSDT', id: 'tron', name: 'TRON' },
  { symbol: 'LINK', binance: 'LINKUSDT', id: 'chainlink', name: 'Chainlink' },
  { symbol: 'DOT', binance: 'DOTUSDT', id: 'polkadot', name: 'Polkadot' },
  { symbol: 'SHIB', binance: 'SHIBUSDT', id: 'shiba-inu', name: 'Shiba Inu' },
  { symbol: 'SUI', binance: 'SUIUSDT', id: 'sui', name: 'Sui' },
  { symbol: 'NEAR', binance: 'NEARUSDT', id: 'near', name: 'NEAR Protocol' },
  { symbol: 'APT', binance: 'APTUSDT', id: 'aptos', name: 'Aptos' },
  { symbol: 'UNI', binance: 'UNIUSDT', id: 'uniswap', name: 'Uniswap' },
  { symbol: 'ATOM', binance: 'ATOMUSDT', id: 'cosmos', name: 'Cosmos' },
  { symbol: 'ARB', binance: 'ARBUSDT', id: 'arbitrum', name: 'Arbitrum' },
  { symbol: 'OP', binance: 'OPUSDT', id: 'optimism', name: 'Optimism' },
  { symbol: 'INJ', binance: 'INJUSDT', id: 'injective-protocol', name: 'Injective' },
  { symbol: 'PEPE', binance: 'PEPEUSDT', id: 'pepe', name: 'Pepe' },
  { symbol: 'FIL', binance: 'FILUSDT', id: 'filecoin', name: 'Filecoin' },
  { symbol: 'RENDER', binance: 'RENDERUSDT', id: 'render-token', name: 'Render' },
  { symbol: 'POL', binance: 'POLUSDT', id: 'matic-network', name: 'Polygon' },
  { symbol: 'WIF', binance: 'WIFUSDT', id: 'dogwifcoin', name: 'dogwifhat' },
]

interface SpotCoin {
  id: string
  symbol: string
  name: string
  image: string | null
  price: number | null
  change1h: number | null
  change24h: number | null
  change7d: number | null
  high24h: number | null
  low24h: number | null
  volume24h: number | null
  marketCap: number | null
  rank: number | null
}

async function fetchFromCoinGecko(): Promise<SpotCoin[]> {
  const perPage = 100
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=1h,24h,7d`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      throw new Error(`CoinGecko request failed: ${res.status}`)
    }

    const rawJson = await res.json()
    const raw = validateCoinGeckoResponse(CoinGeckoMarketsResponseSchema, rawJson, 'spot/top100')

    return raw.map((c) => ({
      id: c.id,
      symbol: (c.symbol as string).toUpperCase(),
      name: c.name,
      image: typeof c.image === 'string' ? c.image.replace('/large/', '/small/') : (c.image ?? null),
      price: c.current_price,
      change1h: c.price_change_percentage_1h_in_currency ?? null,
      change24h: c.price_change_percentage_24h ?? null,
      change7d: c.price_change_percentage_7d_in_currency ?? null,
      high24h: c.high_24h ?? null,
      low24h: c.low_24h ?? null,
      volume24h: c.total_volume ?? null,
      marketCap: c.market_cap ?? null,
      rank: c.market_cap_rank ?? null,
    }))
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

async function fetchFromBinance(): Promise<SpotCoin[]> {
  const symbols = BINANCE_SYMBOLS.map(s => `"${s.binance}"`).join(',')
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=[${encodeURIComponent(symbols)}]`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!res.ok) {
      throw new Error(`Binance ticker API failed: ${res.status}`)
    }

    interface BinanceTicker {
      symbol: string
      lastPrice: string
      priceChangePercent: string
      highPrice: string
      lowPrice: string
      volume: string
      quoteVolume: string
    }

    const tickers = await res.json() as BinanceTicker[]

    const mapped: (SpotCoin | null)[] = tickers.map((t, idx) => {
      const meta = BINANCE_SYMBOLS.find(s => s.binance === t.symbol)
      if (!meta) return null
      const price = parseFloat(t.lastPrice)
      const change24h = parseFloat(t.priceChangePercent)
      const coin: SpotCoin = {
        id: meta.id,
        symbol: meta.symbol,
        name: meta.name,
        image: null, // Binance doesn't provide images
        price: Number.isFinite(price) ? price : null,
        change1h: null,
        change24h: Number.isFinite(change24h) ? change24h : null,
        change7d: null,
        high24h: parseFloat(t.highPrice) || null,
        low24h: parseFloat(t.lowPrice) || null,
        volume24h: parseFloat(t.quoteVolume) || null,
        marketCap: null,
        rank: idx + 1,
      }
      return coin
    })
    return mapped.filter((c): c is SpotCoin => c !== null)
  } catch (e) {
    clearTimeout(timeoutId)
    throw e
  }
}

export async function GET(_req: NextRequest) {
  try {
    const data = await tieredGetOrSet(
      'api:market:spot:top100',
      async () => {
        // Primary: CoinGecko
        try {
          return await fetchFromCoinGecko()
        } catch (e1) {
          const msg = e1 instanceof Error ? e1.message : String(e1)
          logger.warn('CoinGecko failed, falling back to Binance', { error: msg })
        }

        // Fallback: Binance public ticker API (no auth required)
        return await fetchFromBinance()
      },
      'hot', // Redis 5min, memory 1min
      ['market', 'spot']
    )

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    })
  } catch (e: unknown) {
    logger.error('All market spot sources failed', { error: e instanceof Error ? e.message : String(e) })
    // Return empty array (not 500) so the ticker shows "–" instead of crashing
    return NextResponse.json([], {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Market-Error': e instanceof Error ? e.message : 'unknown',
      },
    })
  }
}
