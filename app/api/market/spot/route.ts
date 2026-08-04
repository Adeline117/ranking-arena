/**
 * GET /api/market/spot
 * Fetches top coins from CoinGecko /coins/markets with tiered caching (memory → Redis).
 * Fallback chain: CoinGecko → Binance public ticker API
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import {
  createMarketSpotSnapshot,
  marketSpotReceiptHeaders,
  readCoinGeckoSpotResponse,
  type MarketSpotCoin,
  type MarketSpotSnapshot,
} from '@/lib/market/market-spot-client-contract'
import { fetchMarketJson } from '@/lib/market/market-fetch'

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

async function fetchFromCoinGecko(): Promise<MarketSpotSnapshot> {
  const perPage = 100
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=1h,24h,7d`

  const response = await fetchMarketJson(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    timeoutMs: 8_000,
  })
  const snapshot = readCoinGeckoSpotResponse(response.value)
  return createMarketSpotSnapshot({
    ...snapshot,
    coins: snapshot.coins.map((coin) => ({
      ...coin,
      image: typeof coin.image === 'string' ? coin.image.replace('/large/', '/small/') : coin.image,
    })),
  })
}

function positiveOrNull(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function nonnegativeOrNull(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

async function fetchFromBinance(): Promise<MarketSpotSnapshot> {
  const symbols = BINANCE_SYMBOLS.map((s) => `"${s.binance}"`).join(',')
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=[${encodeURIComponent(symbols)}]`

  const response = await fetchMarketJson(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    timeoutMs: 8_000,
  })
  if (!Array.isArray(response.value)) throw new Error('Binance returned a malformed body')

  interface BinanceTicker {
    symbol?: unknown
    lastPrice?: unknown
    priceChangePercent?: unknown
    highPrice?: unknown
    lowPrice?: unknown
    quoteVolume?: unknown
  }

  const coins: MarketSpotCoin[] = []
  for (const candidate of response.value as BinanceTicker[]) {
    if (
      typeof candidate.symbol !== 'string' ||
      typeof candidate.lastPrice !== 'string' ||
      typeof candidate.priceChangePercent !== 'string' ||
      typeof candidate.highPrice !== 'string' ||
      typeof candidate.lowPrice !== 'string' ||
      typeof candidate.quoteVolume !== 'string'
    ) {
      continue
    }
    const meta = BINANCE_SYMBOLS.find((item) => item.binance === candidate.symbol)
    const price = positiveOrNull(candidate.lastPrice)
    const change24h = Number(candidate.priceChangePercent)
    if (!meta || price === null || !Number.isFinite(change24h)) continue
    coins.push({
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      image: null,
      price,
      change1h: null,
      change24h,
      change7d: null,
      high24h: positiveOrNull(candidate.highPrice),
      low24h: positiveOrNull(candidate.lowPrice),
      volume24h: nonnegativeOrNull(candidate.quoteVolume),
      marketCap: null,
      rank: BINANCE_SYMBOLS.findIndex((item) => item.binance === candidate.symbol) + 1,
    })
  }
  if (coins.length === 0) throw new Error('Binance returned no usable spot rows')
  return createMarketSpotSnapshot({
    coins,
    source: 'binance',
    providerLimit: BINANCE_SYMBOLS.length,
    collectedAt: new Date().toISOString(),
  })
}

export async function GET(_req: NextRequest) {
  try {
    const rl = await checkRateLimit(_req, RateLimitPresets.read)
    if (rl) return rl
    const cachedSnapshot = await tieredGetOrSet<MarketSpotSnapshot>(
      'api:market:spot:top100:v2',
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

    const snapshot = createMarketSpotSnapshot(cachedSnapshot)
    return NextResponse.json(snapshot.coins, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        ...marketSpotReceiptHeaders(snapshot),
      },
    })
  } catch (e: unknown) {
    logger.error('All market spot sources failed', {
      error: e instanceof Error ? e.message : String(e),
    })
    return NextResponse.json(
      { error: 'Market spot data unavailable' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    )
  }
}
