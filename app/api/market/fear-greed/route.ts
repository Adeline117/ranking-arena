import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { fetchFearGreedIndex } from '@/lib/utils/fear-greed'
import { getOrSetWithLock } from '@/lib/cache'

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    const result = await getOrSetWithLock(
      'api:market:fear-greed',
      async () => {
        const data = await fetchFearGreedIndex(30)
        return { current: data[0], history: data }
      },
      { ttl: 3600, lockTtl: 10 }
    )

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
      },
    })
  } catch (error) { console.error('[market] Failed:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'Failed to fetch Fear & Greed Index' },
      { status: 500 }
    )
  }
}
