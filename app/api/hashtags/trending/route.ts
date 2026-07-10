/**
 * GET /api/hashtags/trending
 * Return top 20 hashtags by post_count.
 * Cached for 15 minutes.
 */

export const runtime = 'nodejs'
export const maxDuration = 10

import { NextRequest } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getTrendingHashtags } from '@/lib/data/hashtags'
import { getServerCache, setServerCache } from '@/lib/utils/server-cache'

const CACHE_KEY = 'hashtags:trending'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    // Non-personalized global data — safe to edge-cache. Mirrors the 15 min
    // server-cache TTL so shared CDN/browser caching absorbs repeat traffic.
    const edgeCacheHeader = {
      'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800',
    }

    // Check cache first (15 min)
    const cached = getServerCache<Awaited<ReturnType<typeof getTrendingHashtags>>>(CACHE_KEY)
    if (cached) {
      return success({ hashtags: cached }, 200, edgeCacheHeader)
    }

    const supabase = getSupabaseAdmin()
    const hashtags = await getTrendingHashtags(supabase, 20)

    // Cache for 15 minutes
    setServerCache(CACHE_KEY, hashtags, 900)

    return success({ hashtags }, 200, edgeCacheHeader)
  } catch (error: unknown) {
    return handleError(error, 'hashtags trending GET')
  }
}
