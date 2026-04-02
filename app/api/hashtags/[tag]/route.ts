/**
 * GET /api/hashtags/[tag]
 * Return posts for a specific hashtag, paginated.
 */

export const runtime = 'edge'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  successWithPagination,
  handleError,
  checkRateLimit,
  RateLimitPresets,
  validateNumber,
  validateEnum,
} from '@/lib/api'
import { getPostsByHashtag } from '@/lib/data/hashtags'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tag: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { tag } = await params
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const sort_by = validateEnum(
      searchParams.get('sort_by'),
      ['hot_score', 'created_at'] as const
    ) ?? 'created_at'

    const supabase = getSupabaseAdmin()
    const { posts, total } = await getPostsByHashtag(supabase, tag, { limit, offset, sort_by })

    return successWithPagination(
      { posts, tag: tag.toLowerCase(), total },
      { limit, offset, has_more: posts.length === limit }
    )
  } catch (error: unknown) {
    return handleError(error, 'hashtags [tag] GET')
  }
}
