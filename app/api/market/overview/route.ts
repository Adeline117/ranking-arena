import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { get, set } from '@/lib/cache'

export const runtime = 'edge'

interface MarketOverviewData {
  btcPrice: number
  btcChange24h: number
  ethPrice: number
  ethChange24h: number
  totalMarketCap: number
  totalVolume24h: number
  btcDominance: number
  ethGasGwei: number | null
  updatedAt: string
}

const CACHE_KEY = 'market:overview'
const STALE_KEY = 'market:overview:stale'
/** Fresh TTL — data considered fresh for 5 minutes (market data doesn't need sub-minute freshness) */
const FRESH_TTL = 300
/** Stale TTL — stale copy kept for 1 hour as fallback */
const STALE_TTL = 3600

const logger = createLogger('market-overview-api')

/**
 * Fetch gas price from Etherscan (best-effort, returns null on failure).
 */
async function fetchGasPrice(): Promise<number | null> {
  try {
    const res = await fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle', {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { result?: { ProposeGasPrice?: string } }
    return d.result?.ProposeGasPrice ? parseFloat(d.result.ProposeGasPrice) : null
  } catch {
    return null
  }
}

/**
 * Fetch market data from CoinGecko + Etherscan.
 * All three requests run in parallel to minimize latency.
 */
async function fetchFromCoinGecko(): Promise<MarketOverviewData> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const [globalRes, pricesRes, gasResult] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global', {
        headers: { accept: 'application/json', 'User-Agent': 'RankingArena/1.0' },
        signal: controller.signal,
      }),
      fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
        {
          headers: { accept: 'application/json', 'User-Agent': 'RankingArena/1.0' },
          signal: controller.signal,
        }
      ),
      fetchGasPrice(),
    ])

    clearTimeout(timeoutId)

    if (!globalRes.ok || !pricesRes.ok) {
      throw new Error(`CoinGecko error: global=${globalRes.status} prices=${pricesRes.status}`)
    }

    const [globalData, pricesData] = await Promise.all([
      globalRes.json() as Promise<{
        data: {
          total_market_cap: Record<string, number>
          total_volume: Record<string, number>
          market_cap_percentage: Record<string, number>
        }
      }>,
      pricesRes.json() as Promise<{
        bitcoin: { usd: number; usd_24h_change: number }
        ethereum: { usd: number; usd_24h_change: number }
      }>,
    ])

    return {
      btcPrice: pricesData.bitcoin.usd,
      btcChange24h: pricesData.bitcoin.usd_24h_change,
      ethPrice: pricesData.ethereum.usd,
      ethChange24h: pricesData.ethereum.usd_24h_change,
      totalMarketCap: globalData.data.total_market_cap.usd,
      totalVolume24h: globalData.data.total_volume.usd,
      btcDominance: globalData.data.market_cap_percentage.btc,
      ethGasGwei: gasResult,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fallback: fetch BTC/ETH prices from Coinbase (no rate limits, no API key).
 * Only provides prices — market cap / dominance / volume are unavailable.
 */
async function fetchFromCoinbase(): Promise<MarketOverviewData> {
  const base = 'https://api.exchange.coinbase.com'
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const [btcRes, ethRes, gasResult] = await Promise.all([
      fetch(`${base}/products/BTC-USD/stats`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }),
      fetch(`${base}/products/ETH-USD/stats`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }),
      fetchGasPrice(),
    ])

    clearTimeout(timeoutId)

    if (!btcRes.ok || !ethRes.ok) {
      throw new Error(`Coinbase error: btc=${btcRes.status} eth=${ethRes.status}`)
    }

    const [btcData, ethData] = await Promise.all([
      btcRes.json() as Promise<{ open?: string; last?: string }>,
      ethRes.json() as Promise<{ open?: string; last?: string }>,
    ])

    const btcPrice = parseFloat(btcData.last || '0')
    const btcOpen = parseFloat(btcData.open || '0')
    const ethPrice = parseFloat(ethData.last || '0')
    const ethOpen = parseFloat(ethData.open || '0')

    if (!btcPrice || !ethPrice) {
      throw new Error('Coinbase returned invalid prices')
    }

    const btcChange = btcOpen > 0 ? ((btcPrice - btcOpen) / btcOpen) * 100 : 0
    const ethChange = ethOpen > 0 ? ((ethPrice - ethOpen) / ethOpen) * 100 : 0

    return {
      btcPrice,
      btcChange24h: btcChange,
      ethPrice,
      ethChange24h: ethChange,
      totalMarketCap: 0, // Not available from Coinbase
      totalVolume24h: 0,
      btcDominance: 0,
      ethGasGwei: gasResult,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fallback: fetch BTC/ETH prices from Binance.
 */
async function fetchFromBinance(): Promise<MarketOverviewData> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(['BTCUSDT', 'ETHUSDT']))
    const [tickerRes, gasResult] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${symbolsParam}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }),
      fetchGasPrice(),
    ])

    clearTimeout(timeoutId)

    if (!tickerRes.ok) {
      throw new Error(`Binance error: ${tickerRes.status}`)
    }

    interface BinanceTicker {
      symbol: string
      lastPrice: string
      priceChangePercent: string
    }

    const tickers = (await tickerRes.json()) as BinanceTicker[]
    const btcTicker = tickers.find((t) => t.symbol === 'BTCUSDT')
    const ethTicker = tickers.find((t) => t.symbol === 'ETHUSDT')

    if (!btcTicker || !ethTicker) {
      throw new Error('Binance missing BTC/ETH tickers')
    }

    const btcPrice = parseFloat(btcTicker.lastPrice)
    const ethPrice = parseFloat(ethTicker.lastPrice)

    if (!btcPrice || !ethPrice) {
      throw new Error('Binance returned invalid prices')
    }

    return {
      btcPrice,
      btcChange24h: parseFloat(btcTicker.priceChangePercent) || 0,
      ethPrice,
      ethChange24h: parseFloat(ethTicker.priceChangePercent) || 0,
      totalMarketCap: 0,
      totalVolume24h: 0,
      btcDominance: 0,
      ethGasGwei: gasResult,
      updatedAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fallback: extract BTC/ETH prices from the /api/market Redis cache.
 * The /api/market endpoint caches with key api:market:<sorted-symbols>.
 * We look for BTC-USD and ETH-USD rows from the default pairs cache.
 */
async function buildOverviewFromMarketCache(): Promise<MarketOverviewData | null> {
  // The /api/market caches rows under this pattern. We check a small BTC+ETH specific key first,
  // then fall back to scanning the default full-pairs key.
  interface MarketRow {
    symbol: string
    price: string
    changePct: string
    direction: 'up' | 'down'
  }
  interface MarketCacheData {
    rows: MarketRow[]
    source: string
  }

  // Default pairs sorted key (matches /api/market default request)
  const defaultPairs = [
    'ADA-USD',
    'APT-USD',
    'ARB-USD',
    'ATOM-USD',
    'AVAX-USD',
    'BNB-USD',
    'BTC-USD',
    'DOGE-USD',
    'DOT-USD',
    'ETH-USD',
    'FIL-USD',
    'INJ-USD',
    'LINK-USD',
    'MATIC-USD',
    'NEAR-USD',
    'OP-USD',
    'PEPE-USD',
    'RENDER-USD',
    'SHIB-USD',
    'SOL-USD',
    'SUI-USD',
    'TRX-USD',
    'UNI-USD',
    'WIF-USD',
    'XRP-USD',
  ]
  const redisCacheKey = `api:market:${defaultPairs.join(',')}`

  try {
    const cached = await get<MarketCacheData>(redisCacheKey)
    if (!cached || !cached.rows?.length) return null

    const btcRow = cached.rows.find((r) => r.symbol === 'BTC-USD')
    const ethRow = cached.rows.find((r) => r.symbol === 'ETH-USD')

    if (!btcRow || !ethRow) return null

    // Parse price string (may contain commas from toLocaleString)
    const btcPrice = parseFloat(btcRow.price.replace(/,/g, ''))
    const ethPrice = parseFloat(ethRow.price.replace(/,/g, ''))

    if (!btcPrice || !ethPrice) return null

    // Parse changePct string like "+2.34%" or "-1.50%"
    const btcChange = parseFloat(btcRow.changePct.replace('%', '')) || 0
    const ethChange = parseFloat(ethRow.changePct.replace('%', '')) || 0

    logger.info('Built overview from /api/market cache', { source: cached.source })

    return {
      btcPrice,
      btcChange24h: btcChange,
      ethPrice,
      ethChange24h: ethChange,
      totalMarketCap: 0,
      totalVolume24h: 0,
      btcDominance: 0,
      ethGasGwei: null,
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Try all sources in order: CoinGecko → Coinbase → Binance.
 * Returns the first successful result.
 */
async function fetchMarketData(): Promise<MarketOverviewData> {
  // 1. CoinGecko (has global market cap, dominance, etc.)
  try {
    return await fetchFromCoinGecko()
  } catch (e) {
    logger.warn('CoinGecko failed, trying Coinbase', { error: String(e) })
  }

  // 2. Coinbase (prices only, no market cap)
  try {
    return await fetchFromCoinbase()
  } catch (e) {
    logger.warn('Coinbase failed, trying Binance', { error: String(e) })
  }

  // 3. Binance (prices only, no market cap)
  return await fetchFromBinance()
}

/**
 * Persist data to both fresh and stale cache layers.
 * The stale layer has a much longer TTL and is used when fresh data
 * cannot be fetched (stale-while-revalidate).
 */
async function cacheResult(data: MarketOverviewData): Promise<void> {
  await Promise.all([
    set(CACHE_KEY, data, { ttl: FRESH_TTL }),
    set(STALE_KEY, data, { ttl: STALE_TTL }),
  ])
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    // 1. Try fresh cache — should resolve in <5ms for warm hits
    const fresh = await get<MarketOverviewData>(CACHE_KEY)
    if (fresh !== null) {
      return NextResponse.json(fresh, {
        headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
      })
    }

    // 2. Fresh miss — try stale cache and kick off background revalidation
    const stale = await get<MarketOverviewData>(STALE_KEY)
    if (stale !== null) {
      // Serve stale immediately, revalidate in background (fire-and-forget)
      void fetchMarketData()
        .then((data) => cacheResult(data))
        .catch((e) => logger.warn('Background revalidation failed', { error: String(e) }))

      return NextResponse.json(stale, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
      })
    }

    // 3. Full cold start — no cache at all, must fetch synchronously
    const data = await fetchMarketData()
    // Don't await cache write on the hot path
    void cacheResult(data).catch((e) => logger.warn('Cache write failed', { error: String(e) }))

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    logger.error('Market overview fetch failed (all sources)', { error: msg })

    // Last resort 1: try stale cache even on error
    const stale = await get<MarketOverviewData>(STALE_KEY).catch(() => null)
    if (stale !== null) {
      return NextResponse.json(stale, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      })
    }

    // Last resort 2: try to build partial data from /api/market Redis cache
    // (that endpoint uses CoinGecko→Coinbase→Binance fallback and is usually warm)
    const fromMarket = await buildOverviewFromMarketCache()
    if (fromMarket !== null) {
      // Cache it so subsequent requests don't need to reconstruct
      void cacheResult(fromMarket).catch(() => {})
      return NextResponse.json(fromMarket, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      })
    }

    logger.error('All fallbacks exhausted, returning zeros')

    const fallback: MarketOverviewData = {
      btcPrice: 0,
      btcChange24h: 0,
      ethPrice: 0,
      ethChange24h: 0,
      totalMarketCap: 0,
      totalVolume24h: 0,
      btcDominance: 0,
      ethGasGwei: null,
      updatedAt: new Date().toISOString(),
    }

    return NextResponse.json(fallback, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    })
  }
}
