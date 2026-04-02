import { NextResponse } from 'next/server'
import { fetchFearGreedIndex } from '@/lib/utils/fear-greed'
import { getOrSetWithLock } from '@/lib/cache'

export async function GET() {
  try {
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
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to fetch Fear & Greed Index' },
      { status: 500 }
    )
  }
}
