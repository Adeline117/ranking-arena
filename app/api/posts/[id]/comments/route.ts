/**
 * 帖子评论 API
 * GET /api/posts/[id]/comments - 获取评论列表
 * POST /api/posts/[id]/comments - 添加评论
 * DELETE /api/posts/[id]/comments - 删除评论
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
} from '@/lib/api'
import { getPostComments, createComment, deleteComment } from '@/lib/data/comments'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params
    const { searchParams } = new URL(request.url)
    
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    const supabase = getSupabaseAdmin()
    
    // 尝试获取当前用户ID（用于获取点赞状态）
    let userId: string | undefined
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      userId = user?.id
    }
    
    const comments = await getPostComments(supabase, id, { limit, offset, userId })

    return successWithPagination(
      { comments },
      { limit, offset, has_more: comments.length === limit }
    )
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments GET')
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // Check if the post belongs to a group and if user is muted
    const { data: post } = await supabase
      .from('posts')
      .select('group_id')
      .eq('id', id)
      .single()

    if (post?.group_id) {
      const { data: membership } = await supabase
        .from('group_members')
        .select('muted_until')
        .eq('group_id', post.group_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (membership?.muted_until && new Date(membership.muted_until) > new Date()) {
        return new Response(JSON.stringify({ error: 'You have been muted', success: false }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    const body = await request.json()
    const content = validateString(body.content, {
      required: true,
      minLength: 1,
      maxLength: 2000,
      fieldName: 'comment content',
    })!
    const parent_id = validateString(body.parent_id) ?? undefined

    const comment = await createComment(supabase, user.id, {
      post_id: id,
      content,
      parent_id,
    })

    return success({ comment }, 201)
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments POST')
  }
}

export async function DELETE(request: NextRequest, _context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const commentId = validateString(body.comment_id, {
      required: true,
      fieldName: 'comment ID',
    })!

    await deleteComment(supabase, commentId, user.id)

    return success({ message: 'Comment deleted' })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/comments DELETE')
  }
}
