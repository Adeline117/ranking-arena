/**
 * GET /api/market/alpha
 * Trending tokens + high volume movers from CoinGecko.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

interface CachedData { data: unknown; ts: number }
let cache: CachedData | null = null
const CACHE_TTL = 120_000

export async function GET() {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  try {
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

    let trending: any[] = []
    if (trendingRes.ok) {
      const tData = await trendingRes.json()
      trending = (tData.coins || []).map((c: any) => ({
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

    let volumeMovers: any[] = []
    if (volumeRes.ok) {
      const vData: any[] = await volumeRes.json()
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

    const result = { trending, volumeMovers }
    cache = { data: result, ts: now }
    return NextResponse.json(result)
  } catch (e: unknown) {
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
