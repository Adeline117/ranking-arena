import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { fetchDefiOverview } from '@/lib/utils/defillama'
import { getOrSetWithLock } from '@/lib/cache'
import { logger } from '@/lib/utils/logger'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl
    const data = await getOrSetWithLock('api:market:defi', async () => fetchDefiOverview(), {
      ttl: 1800,
      lockTtl: 10,
    })

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=900',
      },
    })
  } catch (error) {
    logger.error('[market/defi] Failed:', error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json({ error: 'Failed to fetch DeFi overview' }, { status: 500 })
  }
}
