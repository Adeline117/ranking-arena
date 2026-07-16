/**
 * 帖子评论 API
 * GET /api/posts/[id]/comments - 获取评论列表
 * POST /api/posts/[id]/comments - 添加评论
 * PUT /api/posts/[id]/comments - 编辑评论
 * DELETE /api/posts/[id]/comments - 删除评论
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { success, successWithPagination, validateNumber, ApiError, ErrorCode } from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { getPostComments, createComment, type CommentSortMode } from '@/lib/data/comments'
import {
  CommentMutationRolloutError,
  deleteOwnCommentWithRollout,
  updateOwnCommentWithRollout,
} from '@/lib/data/comment-mutation-rollout'
import { sendNotification } from '@/lib/data/notifications'
import { updateCount } from '@/lib/services/counters'
import { socialFeatureGuard } from '@/lib/features'
import { getAuthUser, getUserHandle } from '@/lib/supabase/server'
import logger, { fireAndForget } from '@/lib/logger'
// sanitizeText is dynamically imported inside POST/PUT only — keeps the
// sanitize-html parser out of the GET handler's module graph at cold-start.

// Zod schema for POST (create comment)
const CreateCommentSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, 'Comment content is required')
      .max(2000, 'Comment must be at most 2000 characters'),
    parent_id: z.string().uuid().optional().nullable(),
  })
  .strict()

// Zod schema for PUT (edit comment)
const EditCommentSchema = z.object({
  comment_id: z.string().uuid('Invalid comment ID'),
  content: z
    .string()
    .min(1, 'Comment content is required')
    .max(2000, 'Comment must be at most 2000 characters'),
})

// Zod schema for DELETE (delete comment)
const DeleteCommentSchema = z.object({
  comment_id: z.string().uuid('Invalid comment ID'),
})

const PostIdSchema = z.string().uuid('Invalid post ID')

/** Extract post id from URL path */
function extractPostId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return pathParts[postsIdx + 1]
}

function requirePostId(url: string): string {
  const parsed = PostIdSchema.safeParse(extractPostId(url))
  if (!parsed.success) throw ApiError.validation('Invalid post ID')
  return parsed.data
}

function rethrowCommentMutation(error: unknown, action: 'updated' | 'deleted'): never {
  if (!(error instanceof CommentMutationRolloutError)) throw error

  if (error.kind === 'not_found') throw ApiError.notFound('Comment not found')
  if (error.kind === 'forbidden') {
    throw ApiError.forbidden(
      action === 'updated'
        ? 'You can only edit your own comments'
        : 'You can only delete your own comments'
    )
  }
  if (error.kind === 'validation') throw ApiError.validation('Invalid comment mutation')
  if (error.kind === 'conflict') {
    throw new ApiError(`Comment could not be ${action}`, {
      code: ErrorCode.OPERATION_FAILED,
      statusCode: 409,
    })
  }
  throw ApiError.internal(`Comment could not be ${action}`)
}

type LegacyInteractablePost = {
  author_id: string
  group_id: string | null
  visibility: string
}

async function hasBidirectionalBlock(
  supabase: SupabaseClient,
  viewerId: string,
  authorId: string
): Promise<boolean> {
  if (viewerId === authorId) return false

  const { data, error } = await supabase
    .from('blocked_users')
    .select('blocker_id')
    .or(
      `and(blocker_id.eq.${viewerId},blocked_id.eq.${authorId}),` +
        `and(blocker_id.eq.${authorId},blocked_id.eq.${viewerId})`
    )
    .limit(1)
    .maybeSingle()

  if (error) {
    logger.error('[comments POST] Block permission lookup failed', { code: error.code })
    throw ApiError.internal('Comment permission could not be checked')
  }
  return !!data
}

async function assertLegacyCreateAudience(
  supabase: SupabaseClient,
  userId: string,
  post: LegacyInteractablePost
): Promise<void> {
  if (await hasBidirectionalBlock(supabase, userId, post.author_id)) {
    throw ApiError.forbidden('You cannot interact with this user')
  }

  if (post.group_id) {
    const [groupResult, membershipResult, banResult] = await Promise.all([
      supabase.from('groups').select('id, dissolved_at').eq('id', post.group_id).maybeSingle(),
      supabase
        .from('group_members')
        .select('user_id, muted_until')
        .eq('group_id', post.group_id)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('group_bans')
        .select('user_id')
        .eq('group_id', post.group_id)
        .eq('user_id', userId)
        .maybeSingle(),
    ])

    if (groupResult.error || membershipResult.error || banResult.error) {
      logger.error('[comments POST] Group permission lookup failed', {
        groupCode: groupResult.error?.code,
        membershipCode: membershipResult.error?.code,
        banCode: banResult.error?.code,
      })
      throw ApiError.internal('Comment permission could not be checked')
    }
    if (!groupResult.data || groupResult.data.dissolved_at) {
      throw ApiError.forbidden('This group is read-only')
    }
    if (banResult.data) throw ApiError.forbidden('You are banned from this group')
    if (!membershipResult.data) {
      throw ApiError.forbidden('You must be a member to interact in this group')
    }
    if (
      membershipResult.data.muted_until &&
      new Date(membershipResult.data.muted_until) > new Date()
    ) {
      throw ApiError.forbidden('You have been muted')
    }
    return
  }

  if (post.visibility === 'followers' && post.author_id !== userId) {
    const { data, error } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .eq('following_id', post.author_id)
      .maybeSingle()

    if (error) {
      logger.error('[comments POST] Follower permission lookup failed', { code: error.code })
      throw ApiError.internal('Comment permission could not be checked')
    }
    if (!data) throw ApiError.forbidden('Only followers can interact with this post')
  } else if (post.visibility !== 'public') {
    // Includes malformed legacy group-only rows without a group resource.
    throw ApiError.forbidden('This post is not available')
  }
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
    const userId = (await getAuthUser(request))?.id

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

    const id = requirePostId(request.url)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = CreateCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    // Sanitize comment content — strip HTML/scripts before DB storage
    const { sanitizeText } = await import('@/lib/utils/sanitize')
    const content = sanitizeText(parsed.data.content, { preserveNewlines: true, maxLength: 2000 })
    if (!content.trim()) throw ApiError.validation('Comment content is required')
    const parent_id = parsed.data.parent_id ?? undefined

    const [postResult, parentResult] = await Promise.all([
      supabase
        .from('posts')
        .select('id, group_id, author_id, title, visibility, status')
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      parent_id
        ? supabase
            .from('comments')
            .select('id, post_id, parent_id, user_id')
            .eq('id', parent_id)
            .is('deleted_at', null)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

    if (postResult.error) {
      logger.error('[comments POST] Post lookup failed', { code: postResult.error.code })
      throw ApiError.internal('Comment could not be created')
    }
    const post = postResult.data
    if (!post) throw ApiError.notFound('Post not found')
    if (post.status !== 'active') {
      throw new ApiError('Post is not open for comments', {
        code: ErrorCode.OPERATION_FAILED,
        statusCode: 409,
      })
    }

    if (parentResult.error) {
      logger.error('[comments POST] Parent lookup failed', { code: parentResult.error.code })
      throw ApiError.internal('Comment could not be created')
    }
    const parentComment = parentResult.data
    if (parent_id && !parentComment) throw ApiError.notFound('Parent comment not found')
    if (parentComment && parentComment.post_id !== id) {
      throw ApiError.notFound('Parent comment not found')
    }
    if (parentComment?.parent_id) {
      throw ApiError.validation('Replies may only target a top-level comment')
    }

    // This is the compatibility window before the database integrity trigger
    // is installed. The service-role client bypasses RLS, so every audience
    // and dissolved-group check must be explicit here.
    await assertLegacyCreateAudience(supabase, user.id, post)
    if (
      parentComment &&
      parentComment.user_id !== post.author_id &&
      (await hasBidirectionalBlock(supabase, user.id, parentComment.user_id))
    ) {
      throw ApiError.forbidden('You cannot reply to this user')
    }

    const comment = await createComment(supabase, user.id, {
      post_id: id,
      content,
      parent_id,
    })

    // Atomically increment comment count (fire-and-forget)
    updateCount(supabase, 'increment_comment_count', { p_post_id: id }, 'Increment comment count')

    // Send comment notifications (truly fire-and-forget — don't block response)
    fireAndForget(
      (async () => {
        const userHandle = await getUserHandle(user.id, user.email ?? undefined)

        // Notify post author
        if (post.author_id && post.author_id !== user.id) {
          sendNotification(
            supabase,
            {
              user_id: post.author_id,
              type: 'comment',
              title: `${userHandle} commented on your post`,
              message: content.slice(0, 100),
              actor_id: user.id,
              link: `/post/${id}`,
              reference_id: id,
              read: false,
            },
            'Comment notification'
          )
        }

        // If this is a reply, also notify the parent comment author
        if (parent_id) {
          if (
            parentComment?.user_id &&
            parentComment.user_id !== user.id &&
            parentComment.user_id !== post.author_id
          ) {
            sendNotification(
              supabase,
              {
                user_id: parentComment.user_id,
                type: 'post_reply',
                title: `${userHandle} replied to your comment`,
                message: content.slice(0, 100),
                actor_id: user.id,
                link: `/post/${id}`,
                reference_id: id,
                read: false,
              },
              'Reply notification'
            )
          }
        }
      })(),
      'Comment notifications'
    )

    return success({ comment }, 201)
  },
  { name: 'posts/comments-post', rateLimit: 'write' }
)

export const PUT = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = requirePostId(request.url)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = EditCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const comment_id = parsed.data.comment_id
    // Sanitize edited content — strip HTML/scripts before DB storage
    const { sanitizeText } = await import('@/lib/utils/sanitize')
    const content = sanitizeText(parsed.data.content, { preserveNewlines: true, maxLength: 2000 })
    if (!content.trim()) throw ApiError.validation('Comment content is required')

    let updated
    try {
      updated = await updateOwnCommentWithRollout(supabase, {
        commentId: comment_id,
        postId,
        userId: user.id,
        content,
      })
    } catch (error: unknown) {
      rethrowCommentMutation(error, 'updated')
    }

    return success({ comment: updated })
  },
  { name: 'posts/comments-put', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postId = requirePostId(request.url)

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = DeleteCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const commentId = parsed.data.comment_id

    let result
    try {
      result = await deleteOwnCommentWithRollout(supabase, {
        commentId,
        postId,
        userId: user.id,
      })
    } catch (error: unknown) {
      rethrowCommentMutation(error, 'deleted')
    }

    return success({ message: 'Comment deleted', ...result })
  },
  { name: 'posts/comments-delete', rateLimit: 'write' }
)
