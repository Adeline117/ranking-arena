import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { fetchSectorPerformance } from '@/lib/utils/coingecko'
import { getOrSetWithLock } from '@/lib/cache'

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    const data = await getOrSetWithLock(
      'api:market:sectors',
      async () => fetchSectorPerformance(),
      { ttl: 1800, lockTtl: 10 }
    )

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    })
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to fetch sector performance' },
      { status: 500 }
    )
  }
}
