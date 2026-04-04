import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { get, set } from '@/lib/cache'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

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

/**
 * Fetch market data from CoinGecko + Etherscan.
 * All three requests run in parallel to minimize latency.
 */
async function fetchMarketData(): Promise<MarketOverviewData> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)

  try {
    // Run ALL external calls in parallel (was sequential for gas before)
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
      // Gas is best-effort; catch individually so it doesn't fail the batch
      fetch('https://api.etherscan.io/api?module=gastracker&action=gasoracle', {
        signal: AbortSignal.timeout(3000),
      }).then(async (r) => {
        if (!r.ok) return null
        const d = (await r.json()) as { result?: { ProposeGasPrice?: string } }
        return d.result?.ProposeGasPrice ? parseFloat(d.result.ProposeGasPrice) : null
      }).catch(() => null as number | null),
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

  const logger = createLogger('market-overview-api')

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
    logger.error('Market overview fetch failed', { error: msg })

    // Last resort: try stale cache even on error
    const stale = await get<MarketOverviewData>(STALE_KEY).catch(() => null)
    if (stale !== null) {
      return NextResponse.json(stale, {
        headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
      })
    }

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
