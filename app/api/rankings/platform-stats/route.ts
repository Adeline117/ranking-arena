/**
 * Public platform statistics.
 *
 * Per-platform aggregate ranking metrics require their own sealed aggregate
 * publication. The legacy RPC reads raw rank rows, so it cannot be used as a
 * public fallback while that authority is unavailable.
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

const UNAVAILABLE_PLATFORM_STATS = {
  platforms: [],
  season: '90D',
  ranking_visibility: 'unknown',
  ranking_visibility_reason: 'platform_stats_publication_unavailable',
  ranking_visibility_reasons: ['platform_stats_publication_unavailable'],
} as const

/**
 * GET /api/rankings/platform-stats
 *
 * Keep the historical response shape (`platforms`, `season`) while making
 * unavailable aggregate evidence explicit. This response deliberately reads
 * neither Redis nor a database/RPC: an old cache entry could otherwise replay
 * raw aggregate ranking metrics after the public authority has been removed.
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  return NextResponse.json(UNAVAILABLE_PLATFORM_STATS, { headers: NO_STORE_HEADERS })
}
