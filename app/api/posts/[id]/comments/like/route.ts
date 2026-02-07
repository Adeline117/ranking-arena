/**
 * 评论点赞 API
 * POST /api/posts/[id]/comments/like - 点赞/取消点赞评论
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

const logger = createLogger('comment-like')

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, _context: RouteContext) {
  // 限流：每分钟最多 30 次点赞操作
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const commentId = validateString(body.comment_id, {
      required: true,
      fieldName: 'comment ID',
    })!
    const actionType = body.type === 'dislike' ? 'dislike' : 'like'

    // 检查是否已有 like 或 dislike
    const { data: existingLike } = await supabase
      .from('comment_likes')
      .select('id, reaction_type')
      .eq('comment_id', commentId)
      .eq('user_id', user.id)
      .maybeSingle()

    let liked = false
    let disliked = false
    let likeCount = 0
    let dislikeCount = 0

    // Get current counts
    const { data: currentComment } = await supabase
      .from('comments')
      .select('like_count, dislike_count')
      .eq('id', commentId)
      .single()

    likeCount = currentComment?.like_count || 0
    dislikeCount = currentComment?.dislike_count || 0

    if (existingLike) {
      const existingType = existingLike.reaction_type || 'like'

      if (existingType === actionType) {
        // Toggle off: remove the reaction
        await supabase.from('comment_likes').delete().eq('id', existingLike.id)
        if (actionType === 'like') {
          likeCount = Math.max(0, likeCount - 1)
        } else {
          dislikeCount = Math.max(0, dislikeCount - 1)
        }
      } else {
        // Switch: change reaction type
        await supabase.from('comment_likes').update({ reaction_type: actionType }).eq('id', existingLike.id)
        if (actionType === 'like') {
          likeCount += 1
          dislikeCount = Math.max(0, dislikeCount - 1)
          liked = true
        } else {
          dislikeCount += 1
          likeCount = Math.max(0, likeCount - 1)
          disliked = true
        }
      }
    } else {
      // New reaction
      await supabase.from('comment_likes').insert({
        comment_id: commentId,
        user_id: user.id,
        reaction_type: actionType,
      })
      if (actionType === 'like') {
        likeCount += 1
        liked = true
      } else {
        dislikeCount += 1
        disliked = true
      }
    }

    // Update counts
    await supabase
      .from('comments')
      .update({ like_count: likeCount, dislike_count: dislikeCount })
      .eq('id', commentId)

    return success({ liked, disliked, like_count: likeCount, dislike_count: dislikeCount })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments/like POST')
  }
}
