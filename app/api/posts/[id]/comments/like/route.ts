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
import { socialFeatureGuard } from '@/lib/features'

const _logger = createLogger('comment-like')

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, _context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

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

    if (existingLike) {
      const existingType = existingLike.reaction_type || 'like'

      if (existingType === actionType) {
        // Toggle off: remove the reaction - use compound match for safety
        await supabase.from('comment_likes').delete()
          .eq('comment_id', commentId)
          .eq('user_id', user.id)
          .eq('reaction_type', actionType)
      } else {
        // Switch: change reaction type
        await supabase.from('comment_likes').update({ reaction_type: actionType })
          .eq('comment_id', commentId)
          .eq('user_id', user.id)
        if (actionType === 'like') { liked = true } else { disliked = true }
      }
    } else {
      // New reaction - use upsert to handle concurrent inserts
      const { error: upsertError } = await supabase.from('comment_likes').upsert({
        comment_id: commentId,
        user_id: user.id,
        reaction_type: actionType,
      }, { onConflict: 'comment_id,user_id' })
      if (upsertError) {
        _logger.error('Failed to upsert comment like:', upsertError)
      }
      if (actionType === 'like') { liked = true } else { disliked = true }
    }

    // Recount from source of truth to avoid race conditions with stale counts (parallel)
    // KEEP 'exact' on both — this is the write path that rebuilds the
    // cached like_count / dislike_count columns on comments. Scoped
    // per-comment via (comment_id, reaction_type) index.
    const [{ count: likeCount }, { count: dislikeCount }] = await Promise.all([
      supabase
        .from('comment_likes')
        .select('id', { count: 'exact', head: true })
        .eq('comment_id', commentId)
        .eq('reaction_type', 'like'),
      supabase
        .from('comment_likes')
        .select('id', { count: 'exact', head: true })
        .eq('comment_id', commentId)
        .eq('reaction_type', 'dislike'),
    ])

    // Update counts atomically from recount
    await supabase
      .from('comments')
      .update({ like_count: likeCount || 0, dislike_count: dislikeCount || 0 })
      .eq('id', commentId)

    return success({ liked, disliked, like_count: likeCount || 0, dislike_count: dislikeCount || 0 })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments/like POST')
  }
}
