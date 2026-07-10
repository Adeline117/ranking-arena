import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getOrSetWithLock } from '@/lib/cache'

// Sentinel thrown when CoinGecko returns a non-2xx status, so the cache lock
// wrapper can surface the upstream status instead of caching an error body.
class UpstreamError extends Error {
  constructor(public status: number) {
    super('CoinGecko API error')
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Per-request rate limit prevents an attacker from enumerating `id` values to
  // exhaust our shared CoinGecko quota.
  const rl = await checkRateLimit(request, RateLimitPresets.read)
  if (rl) return rl

  const { id } = await params

  try {
    // Shared (Redis) cache with a lock so concurrent misses for the same coin
    // collapse into a single upstream fetch — one enumerated id ≠ one CoinGecko hit.
    const data = await getOrSetWithLock(
      `market:coin:${id}`,
      async () => {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&community_data=false&developer_data=false`,
          { next: { revalidate: 300 } }
        )
        if (!res.ok) {
          throw new UpstreamError(res.status)
        }
        return res.json()
      },
      { ttl: 300 }
    )
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    })
  } catch (err) {
    if (err instanceof UpstreamError) {
      return NextResponse.json({ error: 'CoinGecko API error' }, { status: err.status })
    }
    return NextResponse.json({ error: 'Failed to fetch coin data' }, { status: 500 })
  }
}
