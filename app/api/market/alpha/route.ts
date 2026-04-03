/**
 * GET /api/market/alpha
 * Trending tokens + high volume movers from CoinGecko.
 * Redis-cached for 2 minutes with lock.
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getOrSetWithLock } from '@/lib/cache'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    const result = await getOrSetWithLock(
      'api:market:alpha',
      async () => fetchAlphaData(),
      { ttl: 120, lockTtl: 10 }
    )

    const response = NextResponse.json(result)
    response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
    return response
  } catch (_error) {
    return NextResponse.json({ error: 'Failed to fetch market alpha data' }, { status: 500 })
  }
}

interface TrendingToken { id: string; symbol: string; name: string; image: string; rank: number | null; price: number | null; change24h: number | null; volume24h: number | null; marketCap: number | null; score: number }
interface VolumeToken { id: string; symbol: string; name: string; image: string; price: number; change24h: number | null; volume24h: number; marketCap: number; rank: number }

async function fetchAlphaData() {
  const [trendingRes, volumeRes] = await Promise.all([
    fetch('https://api.coingecko.com/api/v3/search/trending', {
      headers: { Accept: 'application/json' },
      next: { revalidate: 120 },
    }),
    fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=30&page=1&sparkline=false&price_change_percentage=24h',
      { headers: { Accept: 'application/json' }, next: { revalidate: 120 } }
    ),
  ])

  let trending: TrendingToken[] = []
  if (trendingRes.ok) {
    const tData = await trendingRes.json()
    trending = (tData.coins || []).map((c: { item: { id: string; symbol?: string; name: string; thumb: string; market_cap_rank: number | null; data?: { price?: number; price_change_percentage_24h?: { usd?: number }; total_volume?: number; market_cap?: number }; score: number } }) => ({
      id: c.item.id,
      symbol: c.item.symbol?.toUpperCase(),
      name: c.item.name,
      image: c.item.thumb,
      rank: c.item.market_cap_rank,
      price: c.item.data?.price,
      change24h: c.item.data?.price_change_percentage_24h?.usd,
      volume24h: c.item.data?.total_volume,
      marketCap: c.item.data?.market_cap,
      score: c.item.score,
    }))
  }

  let volumeMovers: VolumeToken[] = []
  if (volumeRes.ok) {
    const vData: Array<{ id: string; symbol: string; name: string; image: string; current_price: number; price_change_percentage_24h: number | null; total_volume: number; market_cap: number; market_cap_rank: number }> = await volumeRes.json()
    volumeMovers = vData.map((c) => ({
      id: c.id,
      symbol: (c.symbol as string).toUpperCase(),
      name: c.name,
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      volume24h: c.total_volume,
      marketCap: c.market_cap,
      rank: c.market_cap_rank,
    }))
  }

  return { trending, volumeMovers }
}
