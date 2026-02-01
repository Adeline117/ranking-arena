/**
 * 评价点赞 API
 * POST /api/trader/[handle]/reviews/like - 点赞/取消点赞评价
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('review-like')

type RouteContext = { params: Promise<{ handle: string }> }

export async function POST(request: NextRequest, _context: RouteContext) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const reviewId = validateString(body.review_id, {
      required: true,
      fieldName: 'review ID',
    })!

    // 检查是否已经点赞
    const { data: existing } = await supabase
      .from('review_likes')
      .select('id')
      .eq('review_id', reviewId)
      .eq('user_id', user.id)
      .maybeSingle()

    let liked = false
    let likeCount = 0

    if (existing) {
      // 取消点赞
      const { error: deleteError } = await supabase
        .from('review_likes')
        .delete()
        .eq('id', existing.id)

      if (deleteError) throw deleteError

      // 更新评价点赞数
      const { data: review } = await supabase
        .from('trader_reviews')
        .select('like_count')
        .eq('id', reviewId)
        .single()

      likeCount = Math.max(0, (review?.like_count || 1) - 1)

      await supabase
        .from('trader_reviews')
        .update({ like_count: likeCount })
        .eq('id', reviewId)

      liked = false
      logger.debug(`Review unlike: ${reviewId}`)
    } else {
      // 添加点赞
      const { error: insertError } = await supabase
        .from('review_likes')
        .insert({
          review_id: reviewId,
          user_id: user.id,
        })

      if (insertError) throw insertError

      const { data: review } = await supabase
        .from('trader_reviews')
        .select('like_count')
        .eq('id', reviewId)
        .single()

      likeCount = (review?.like_count || 0) + 1

      await supabase
        .from('trader_reviews')
        .update({ like_count: likeCount })
        .eq('id', reviewId)

      liked = true
      logger.debug(`Review like: ${reviewId}`)
    }

    return success({ liked, like_count: likeCount })
  } catch (error: unknown) {
    return handleError(error, 'trader/[handle]/reviews/like POST')
  }
}
