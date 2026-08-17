/**
 * GET /api/recommendations/hot
 *
 * A public "hot" list needs a sealed historical change cohort. Current rank
 * publication alone cannot prove the ROI/follower/activity deltas behind the
 * old composite score, so this endpoint is intentionally fail-closed until
 * that evidence exists.
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { computeHotTraders } from '@/lib/recommendations/hot-score'
import { socialFeatureGuard } from '@/lib/features'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
}

export const GET = withPublic(
  async () => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // Do not replay the former 5-minute hot-score cache. Even an empty
    // response must describe the current publication state rather than a
    // previously valid cohort.
    const result = await computeHotTraders()
    return NextResponse.json(
      {
        success: true,
        data: result.traders,
        ranking_visibility: result.ranking_visibility,
        ranking_visibility_reason: result.ranking_visibility_reason,
        ranking_visibility_reasons: result.ranking_visibility_reasons,
        meta: { count: 0, cached: false },
      },
      { headers: NO_STORE_HEADERS }
    )
  },
  { name: 'get-recommendations-hot', rateLimit: 'public' }
)
