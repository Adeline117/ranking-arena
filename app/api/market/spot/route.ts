/**
 * GET /api/market/spot
 * Fetches top coins from CoinGecko /coins/markets with tiered caching (memory → Redis).
 */
import { NextRequest, NextResponse } from 'next/server'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  try {
    const data = await tieredGetOrSet(
      'api:market:spot:top100',
      async () => {
        const perPage = 100
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=24h`
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          next: { revalidate: 60 },
        })

        if (!res.ok) {
          throw new Error(`CoinGecko request failed: ${res.status}`)
        }

        const raw: Array<{ id: string; symbol: string; name: string; image: string; current_price: number; price_change_percentage_24h: number | null; high_24h: number | null; low_24h: number | null; total_volume: number; market_cap: number; market_cap_rank: number }> = await res.json()

        return raw.map((c) => ({
          id: c.id,
          symbol: (c.symbol as string).toUpperCase(),
          name: c.name,
          image: typeof c.image === 'string' ? c.image.replace('/large/', '/small/') : c.image,
          price: c.current_price,
          change24h: c.price_change_percentage_24h,
          high24h: c.high_24h,
          low24h: c.low_24h,
          volume24h: c.total_volume,
          marketCap: c.market_cap,
          rank: c.market_cap_rank,
        }))
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
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
