/**
 * 帖子评论 API
 * GET /api/posts/[id]/comments - 获取评论列表
 * POST /api/posts/[id]/comments - 添加评论
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
import { getPostComments, createComment } from '@/lib/data/comments'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const { searchParams } = new URL(request.url)
    
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    const supabase = getSupabaseAdmin()
    const comments = await getPostComments(supabase, id, { limit, offset })

    return successWithPagination(
      { comments },
      { limit, offset, has_more: comments.length === limit }
    )
  } catch (error) {
    return handleError(error, 'posts/[id]/comments GET')
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const content = validateString(body.content, {
      required: true,
      minLength: 1,
      maxLength: 2000,
      fieldName: '评论内容',
    })!
    const parent_id = validateString(body.parent_id) ?? undefined

    const comment = await createComment(supabase, user.id, {
      post_id: id,
      content,
      parent_id,
    })

    return success({ comment }, 201)
  } catch (error) {
    return handleError(error, 'posts/[id]/comments POST')
  }
}
