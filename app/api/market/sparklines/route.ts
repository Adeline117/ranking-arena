/**
 * GET /api/market/sparklines
 * Returns 7-day hourly price sparkline data for top 50 coins.
 * Uses CoinGecko /coins/markets?sparkline=true
 * Cached in memory for 4 hours — sparklines don't need real-time updates.
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const dynamic = 'force-dynamic'

interface SparklineEntry {
  id: string
  prices: number[]   // 7-day hourly prices (~168 values)
  change7d: number | null
}

let memCache: { data: SparklineEntry[]; ts: number } | null = null
const CACHE_TTL = 4 * 60 * 60 * 1000 // 4 hours

export async function GET(request: NextRequest) {
  // Serve from memory cache if fresh
  if (memCache && Date.now() - memCache.ts < CACHE_TTL) {
    return NextResponse.json(memCache.data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    })
  }

  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    const url =
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&order=market_cap_desc&per_page=50&page=1' +
      '&sparkline=true&price_change_percentage=7d'

    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })

    if (!res.ok) {
      return NextResponse.json({ error: `CoinGecko error: ${res.status}` }, { status: res.status })
    }

    const raw: Array<{
      id: string
      sparkline_in_7d?: { price: number[] }
      price_change_percentage_7d_in_currency?: number | null
    }> = await res.json()

    const data: SparklineEntry[] = raw.map((c) => ({
      id: c.id,
      prices: c.sparkline_in_7d?.price ?? [],
      change7d: c.price_change_percentage_7d_in_currency ?? null,
    }))

    memCache = { data, ts: Date.now() }

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    })
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
