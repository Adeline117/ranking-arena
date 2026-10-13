/**
 * GET /api/recommendations/personal
 *
 * Authenticated endpoint returning personalized trader recommendations.
 * Only metric-free candidates are cached server-side; ranking fields are read
 * from the current sealed cohort for every response.
 */

import { withAuth } from '@/lib/api/middleware'
import { NextResponse } from 'next/server'
import {
  getPersonalRecommendationCandidates,
  materializePersonalRecommendations,
} from '@/lib/recommendations/personal'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import type { PersonalRecommendationCandidate } from '@/lib/recommendations/personal'
import { parseLimit } from '@/lib/utils/safe-parse'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export const GET = withAuth(
  async ({ user, request }) => {
    const { searchParams } = new URL(request.url)
    const limit = parseLimit(searchParams.get('limit'), 20, 50)

    // v2 caches recommendation identities and reasons only. Ranking-derived
    // fields are re-read from the sealed cohort below for every cache hit.
    const cacheKey = `recommendations:personal:v2:candidates:${user.id}`

    const candidates = await tieredGetOrSet<PersonalRecommendationCandidate[]>(
      cacheKey,
      () => getPersonalRecommendationCandidates(user.id, 50),
      'hot',
      ['recommendations', `user:${user.id}`]
    )
    const result = await materializePersonalRecommendations(candidates, limit)

    return NextResponse.json(
      {
        success: true,
        data: {
          data: result.recommendations,
          meta: { count: result.recommendations.length, userId: user.id },
          ranking_visibility: result.rankingVisibility,
          ...(result.rankingVisibilityReason
            ? {
                ranking_visibility_reason: result.rankingVisibilityReason,
                ranking_visibility_reasons: [result.rankingVisibilityReason],
              }
            : {}),
        },
      },
      { headers: NO_STORE_HEADERS }
    )
  },
  { name: 'get-recommendations-personal', rateLimit: 'authenticated' }
)
