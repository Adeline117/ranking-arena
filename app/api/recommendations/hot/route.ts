/**
 * GET /api/recommendations/hot
 *
 * Public endpoint returning globally hot traders ranked by composite hot score.
 * Results are cached in Upstash Redis with 5-minute TTL.
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { computeHotTraders } from '@/lib/recommendations/hot-score'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import type { HotTrader } from '@/lib/recommendations/hot-score'
import { socialFeatureGuard } from '@/lib/features'

const _logger = createLogger('api-rec-hot')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const CACHE_KEY = 'recommendations:hot'

export const GET = withPublic(async ({ request }) => {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { searchParams } = new URL(request.url)
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
}, { name: 'get-recommendations-hot', rateLimit: 'public' })
