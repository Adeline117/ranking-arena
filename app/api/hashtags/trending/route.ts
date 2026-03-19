/**
 * GET /api/hashtags/trending
 * Return top 20 hashtags by post_count.
 * Cached for 15 minutes.
 */

export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getTrendingHashtags } from '@/lib/data/hashtags'
import { getServerCache, setServerCache, CacheTTL } from '@/lib/utils/server-cache'

const CACHE_KEY = 'hashtags:trending'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    // Check cache first (15 min)
    const cached = getServerCache<Awaited<ReturnType<typeof getTrendingHashtags>>>(CACHE_KEY)
    if (cached) {
      return success({ hashtags: cached })
    }

    const supabase = getSupabaseAdmin()
    const hashtags = await getTrendingHashtags(supabase, 20)

    // Cache for 15 minutes
    setServerCache(CACHE_KEY, hashtags, 900)

    return success({ hashtags })
  } catch (error: unknown) {
    return handleError(error, 'hashtags trending GET')
  }
}
