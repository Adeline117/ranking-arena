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

    // 检查是否已经点赞
    const { data: existing } = await supabase
      .from('comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', user.id)
      .maybeSingle()

    let liked = false
    let likeCount = 0

    if (existing) {
      // 取消点赞：使用原子操作
      const { error: deleteError } = await supabase
        .from('comment_likes')
        .delete()
        .eq('id', existing.id)
      
      if (deleteError) throw deleteError

      // 原子减少点赞数（使用 RPC 函数）
      const { data: result, error: rpcError } = await supabase
        .rpc('decrement_comment_like_count', { p_comment_id: commentId })
      
      if (rpcError) {
        // 如果 RPC 函数不存在，回退到普通更新
        logger.warn(`RPC unavailable, using fallback: ${rpcError.message}`)
        const { data: comment } = await supabase
          .from('comments')
          .select('like_count')
          .eq('id', commentId)
          .single()
        
        likeCount = Math.max(0, (comment?.like_count || 1) - 1)
        
        await supabase
          .from('comments')
          .update({ like_count: likeCount })
          .eq('id', commentId)
      } else {
        likeCount = result ?? 0
      }
      
      liked = false
    } else {
      // 添加点赞
      const { error: insertError } = await supabase
        .from('comment_likes')
        .insert({
          comment_id: commentId,
          user_id: user.id,
        })
      
      if (insertError) throw insertError

      // 原子增加点赞数（使用 RPC 函数）
      const { data: result, error: rpcError } = await supabase
        .rpc('increment_comment_like_count', { p_comment_id: commentId })
      
      if (rpcError) {
        // 如果 RPC 函数不存在，回退到普通更新
        logger.warn(`RPC unavailable, using fallback: ${rpcError.message}`)
        const { data: comment } = await supabase
          .from('comments')
          .select('like_count')
          .eq('id', commentId)
          .single()
        
        likeCount = (comment?.like_count || 0) + 1
        
        await supabase
          .from('comments')
          .update({ like_count: likeCount })
          .eq('id', commentId)
      } else {
        likeCount = result ?? 0
      }
      
      liked = true
    }

    return success({ liked, like_count: likeCount })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments/like POST')
  }
}
