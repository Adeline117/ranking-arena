/**
 * GET /api/recommendations/content
 *
 * Collaborative filtering recommendations via recommend_by_collaborative_filtering RPC.
 * Returns recommended posts/content for authenticated users.
 */

export const runtime = 'nodejs'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  success,
  handleError,
  validateNumber,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const contentType = validateEnum(
      searchParams.get('type'),
      ['post', 'group', 'trader'] as const
    ) ?? 'post'
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20

    const user = await getAuthUser(request)

    if (!user) {
      // Unauthenticated: return hot posts as fallback
      const { data: fallbackData } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url)')
        .order('hot_score', { ascending: false })
        .limit(limit)

      return success({
        recommendations: (fallbackData || []),
        type: contentType,
        personalized: false,
      })
    }

    const { data: rpcData, error: rpcError } = await supabase.rpc(
      'recommend_by_collaborative_filtering',
      { p_user_id: user.id, p_type: contentType, p_limit: limit }
    )

    if (rpcError || !rpcData || !Array.isArray(rpcData) || rpcData.length === 0) {
      // Fallback
      const { data: fallbackData } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url)')
        .order('hot_score', { ascending: false })
        .limit(limit)

      return success({
        recommendations: (fallbackData || []),
        type: contentType,
        personalized: false,
      })
    }

    // Fetch full data based on content type
    const itemIds = rpcData.map((r: Record<string, unknown>) => r.item_id as string)

    if (contentType === 'post') {
      const { data: posts } = await supabase
        .from('posts')
        .select('id, title, content, created_at, hot_score, like_count, comment_count, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url)')
        .in('id', itemIds)

      const postMap = new Map((posts || []).map((p: Record<string, unknown>) => [p.id, p]))
      const ordered = itemIds.map((id: string) => postMap.get(id)).filter(Boolean)

      return success({
        recommendations: ordered,
        type: contentType,
        personalized: true,
      })
    }

    // For other types, return raw RPC data
    return success({
      recommendations: rpcData,
      type: contentType,
      personalized: true,
    })
  } catch (error: unknown) {
    return handleError(error, 'recommendations content GET')
  }
}
