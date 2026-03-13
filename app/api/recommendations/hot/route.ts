/**
 * GET /api/recommendations/hot
 *
 * Public endpoint returning globally hot traders ranked by composite hot score.
 * Results are cached in Upstash Redis with 5-minute TTL.
 */

import { NextRequest, NextResponse } from 'next/server'
import { computeHotTraders } from '@/lib/recommendations/hot-score'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import type { HotTrader } from '@/lib/recommendations/hot-score'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('api-rec-hot')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const CACHE_KEY = 'recommendations:hot'

export async function GET(req: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { searchParams } = new URL(req.url)
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)))

    const traders = await tieredGetOrSet<HotTrader[]>(
      CACHE_KEY,
      () => computeHotTraders(100),
      'hot',
      ['recommendations'],
    )

    const sliced = traders.slice(0, limit)

    const response = NextResponse.json({
      success: true,
      data: sliced,
      meta: { count: sliced.length, cached: true },
    })
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  } catch (error) {
    logger.error('GET /api/recommendations/hot failed', { error })
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    )
  }
}
