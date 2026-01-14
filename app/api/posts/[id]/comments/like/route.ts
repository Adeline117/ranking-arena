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
} from '@/lib/api'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const commentId = validateString(body.comment_id, {
      required: true,
      fieldName: '评论ID',
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
      // 取消点赞
      await supabase
        .from('comment_likes')
        .delete()
        .eq('id', existing.id)
      
      // 更新评论的点赞数
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
      
      liked = false
    } else {
      // 添加点赞
      await supabase
        .from('comment_likes')
        .insert({
          comment_id: commentId,
          user_id: user.id,
        })
      
      // 更新评论的点赞数
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
      
      liked = true
    }

    return success({ liked, like_count: likeCount })
  } catch (error) {
    return handleError(error, 'posts/[id]/comments/like POST')
  }
}

