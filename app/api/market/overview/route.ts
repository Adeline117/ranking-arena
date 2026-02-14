import { NextResponse, NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

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

const TTL_MS = 5 * 60 * 1000 // 5 min cache
let cache: { ts: number; data: MarketOverviewData } | null = null

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const logger = createLogger('market-overview-api')
  const now = Date.now()

  if (cache && now - cache.ts < TTL_MS) {
    return NextResponse.json(cache.data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const [globalRes, pricesRes] = await Promise.all([
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
    ])

    clearTimeout(timeoutId)

    if (!globalRes.ok || !pricesRes.ok) {
      throw new Error(`CoinGecko error: global=${globalRes.status} prices=${pricesRes.status}`)
    }

    const globalData = (await globalRes.json()) as {
      data: {
        total_market_cap: Record<string, number>
        total_volume: Record<string, number>
        market_cap_percentage: Record<string, number>
      }
    }
    const pricesData = (await pricesRes.json()) as {
      bitcoin: { usd: number; usd_24h_change: number }
      ethereum: { usd: number; usd_24h_change: number }
    }

    // Try to get ETH gas from etherscan-like free endpoint (best effort)
    let ethGasGwei: number | null = null
    try {
      const gasRes = await fetch(
        'https://api.etherscan.io/api?module=gastracker&action=gasoracle',
        { signal: AbortSignal.timeout(3000) }
      )
      if (gasRes.ok) {
        const gasData = (await gasRes.json()) as { result?: { ProposeGasPrice?: string } }
        if (gasData.result?.ProposeGasPrice) {
          ethGasGwei = parseFloat(gasData.result.ProposeGasPrice)
        }
      }
    } catch {
      // Gas data is optional
    }

    const data: MarketOverviewData = {
      btcPrice: pricesData.bitcoin.usd,
      btcChange24h: pricesData.bitcoin.usd_24h_change,
      ethPrice: pricesData.ethereum.usd,
      ethChange24h: pricesData.ethereum.usd_24h_change,
      totalMarketCap: globalData.data.total_market_cap.usd,
      totalVolume24h: globalData.data.total_volume.usd,
      btcDominance: globalData.data.market_cap_percentage.btc,
      ethGasGwei,
      updatedAt: new Date().toISOString(),
    }

    cache = { ts: now, data }

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    logger.error('Market overview fetch failed', { error: msg })

    if (cache) {
      return NextResponse.json(cache.data, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      })
    }

    // Fallback data when cache is empty and API fails
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
