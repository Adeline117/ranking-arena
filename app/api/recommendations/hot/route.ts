/**
 * GET /api/recommendations/hot
 *
 * Public endpoint returning globally hot traders ranked by composite hot score.
 * Results are cached in Upstash Redis with 5-minute TTL.
 */

import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { withPublic } from '@/lib/api/middleware'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { computeHotTraders } from '@/lib/recommendations/hot-score'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createLogger } from '@/lib/utils/logger'
import type { HotTrader } from '@/lib/recommendations/hot-score'
import { socialFeatureGuard } from '@/lib/features'
import { parseLimit } from '@/lib/utils/safe-parse'
import { publicRankingCacheKey } from '@/lib/rankings/publication-policy'
import {
  readSealedRankingAuthorityGeneration,
  sealedRankingPublicationIdentity,
} from '@/lib/rankings/read-sealed-ranking-generation'

const _logger = createLogger('api-rec-hot')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const CACHE_KEY_PREFIX = publicRankingCacheKey('recommendations:hot:sealed-v3')
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export const GET = withPublic(
  async ({ request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'), 20, 100)

    const sealedRead = await readSealedRankingAuthorityGeneration(
      getSupabaseAdmin(),
      '90D',
      async (publication) => {
        const publicationFingerprint = createHash('sha256')
          .update(sealedRankingPublicationIdentity(publication))
          .digest('hex')
          .slice(0, 24)
        return tieredGetOrSet<HotTrader[]>(
          `${CACHE_KEY_PREFIX}:${publicationFingerprint}`,
          () => computeHotTraders(100),
          'hot',
          ['recommendations']
        )
      },
      { timeoutMs: 10_000 }
    )
    const traders = sealedRead.value

    const sliced = traders.slice(0, limit)

    return NextResponse.json(
      {
        success: true,
        data: sliced,
        meta: { count: sliced.length, cached: true },
      },
      { headers: NO_STORE_HEADERS }
    )
  },
  { name: 'get-recommendations-hot', rateLimit: 'public' }
)
