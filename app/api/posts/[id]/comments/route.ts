/**
 * 帖子评论 API
 * GET /api/posts/[id]/comments - 获取评论列表
 * POST /api/posts/[id]/comments - 添加评论
 * PUT /api/posts/[id]/comments - 编辑评论
 * DELETE /api/posts/[id]/comments - 删除评论
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  success,
  successWithPagination,
  validateNumber,
  ApiError,
  ErrorCode,
} from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { getPostComments, createComment, deleteComment, type CommentSortMode } from '@/lib/data/comments'
import { createNotificationDeduped } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { getUserHandle } from '@/lib/supabase/server'
import logger from '@/lib/logger'

// Zod schema for POST (create comment)
const CreateCommentSchema = z.object({
  content: z.string().min(1, 'Comment content is required').max(2000, 'Comment must be at most 2000 characters'),
  parent_id: z.string().uuid().optional().nullable(),
})

// Zod schema for PUT (edit comment)
const EditCommentSchema = z.object({
  comment_id: z.string().uuid('Invalid comment ID'),
  content: z.string().min(1, 'Comment content is required').max(2000, 'Comment must be at most 2000 characters'),
})

// Zod schema for DELETE (delete comment)
const DeleteCommentSchema = z.object({
  comment_id: z.string().uuid('Invalid comment ID'),
})

/** Extract post id from URL path */
function extractPostId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return pathParts[postsIdx + 1]
}

export const GET = withPublic(
  async ({ supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const id = extractPostId(request.url)

    // Validate UUID format to prevent PostgreSQL cast errors
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(id)) {
      return successWithPagination({ comments: [] }, { limit: 50, offset: 0, has_more: false })
    }

    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const sortParam = searchParams.get('sort')
    const sort: CommentSortMode = sortParam === 'time' ? 'time' : 'best'

    // 尝试获取当前用户ID（用于获取点赞状态）
    let userId: string | undefined
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      userId = user?.id
    }

    const comments = await getPostComments(supabase, id, { limit, offset, userId, sort })

    return successWithPagination(
      { comments },
      { limit, offset, has_more: comments.length === limit }
    )
  },
  { name: 'posts/comments-get', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const id = extractPostId(request.url)

    // Parse body and check mute status in parallel
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const [, { data: post }] = await Promise.all([
      Promise.resolve(body),
      supabase.from('posts').select('group_id').eq('id', id).single(),
    ])

    const parsed = CreateCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const { content } = parsed.data
    const parent_id = parsed.data.parent_id ?? undefined

    // Check if user is muted in group
    if (post?.group_id) {
      const { data: membership } = await supabase
        .from('group_members')
        .select('muted_until')
        .eq('group_id', post.group_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (membership?.muted_until && new Date(membership.muted_until) > new Date()) {
        throw ApiError.forbidden('You have been muted')
      }
    }

    const comment = await createComment(supabase, user.id, {
      post_id: id,
      content,
      parent_id,
    })

    // Send comment notifications (fire-and-forget)
    try {
      const userHandle = await getUserHandle(user.id, user.email ?? undefined)

      // Notify post author
      const { data: postData } = await supabase
        .from('posts')
        .select('author_id, title')
        .eq('id', id)
        .single()

      if (postData?.author_id && postData.author_id !== user.id) {
        createNotificationDeduped(supabase, {
          user_id: postData.author_id,
          type: 'comment',
          title: `${userHandle} commented on your post`,
          message: content.slice(0, 100),
          actor_id: user.id,
          link: `/post/${id}`,
          reference_id: id,
          read: false,
        }).catch(err => logger.warn('[comments] Post author notification failed:', err))
      }

      // If this is a reply, also notify the parent comment author
      if (parent_id) {
        const { data: parentComment } = await supabase
          .from('comments')
          .select('user_id')
          .eq('id', parent_id)
          .single()

        if (parentComment?.user_id && parentComment.user_id !== user.id && parentComment.user_id !== postData?.author_id) {
          createNotificationDeduped(supabase, {
            user_id: parentComment.user_id,
            type: 'post_reply',
            title: `${userHandle} replied to your comment`,
            message: content.slice(0, 100),
            actor_id: user.id,
            link: `/post/${id}`,
            reference_id: id,
            read: false,
          }).catch(err => logger.warn('[comments] Parent comment notification failed:', err))
        }
      }
    } catch (notifErr) {
      logger.warn('[comments] Notification error:', notifErr)
    }

    return success({ comment }, 201)
  },
  { name: 'posts/comments-post', rateLimit: 'write' }
)

export const PUT = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const parsed = EditCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const { comment_id, content } = parsed.data

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('comments')
      .select('user_id')
      .eq('id', comment_id)
      .single()

    if (fetchError || !existing) {
      throw ApiError.notFound('Comment not found')
    }
    if (existing.user_id !== user.id) {
      throw ApiError.forbidden('You can only edit your own comments')
    }

    // Update comment
    const { data: updated, error: updateError } = await supabase
      .from('comments')
      .update({
        content,
        updated_at: new Date().toISOString(),
      })
      .eq('id', comment_id)
      .select()
      .single()

    if (updateError) {
      logger.error('[comments PUT] Update failed:', updateError)
      throw new ApiError('Update failed', { code: ErrorCode.INTERNAL_ERROR })
    }

    return success({ comment: updated })
  },
  { name: 'posts/comments-put', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const parsed = DeleteCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const commentId = parsed.data.comment_id

    await deleteComment(supabase, commentId, user.id)

    return success({ message: 'Comment deleted' })
  },
  { name: 'posts/comments-delete', rateLimit: 'write' }
)
