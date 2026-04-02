import { NextResponse } from 'next/server'
import { fetchDefiOverview } from '@/lib/utils/defillama'
import { getOrSetWithLock } from '@/lib/cache'

export async function GET() {
  try {
    const data = await getOrSetWithLock(
      'api:market:defi',
      async () => fetchDefiOverview(),
      { ttl: 1800, lockTtl: 10 }
    )

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    })
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to fetch DeFi overview' },
      { status: 500 }
    )
  }
}
