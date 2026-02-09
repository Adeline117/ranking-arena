import { NextRequest, NextResponse } from 'next/server'

const cache = new Map<string, { data: unknown; ts: number }>()
const CACHE_TTL = 5 * 60 * 1000

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const days = req.nextUrl.searchParams.get('days') || '30'
  const key = `ohlc:${id}:${days}`
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data)
  }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=${days}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) {
      return NextResponse.json({ error: 'CoinGecko API error' }, { status: res.status })
    }
    const data = await res.json()
    cache.set(key, { data, ts: Date.now() })
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch OHLC data' }, { status: 500 })
  }
}
