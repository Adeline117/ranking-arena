/**
 * 帖子评论 API
 * GET /api/posts/[id]/comments - 获取评论列表
 * POST /api/posts/[id]/comments - 添加评论
 * PUT /api/posts/[id]/comments - 编辑评论
 * DELETE /api/posts/[id]/comments - 删除评论
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { success, successWithPagination, validateNumber, ApiError, ErrorCode } from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { getPostComments, createComment, type CommentSortMode } from '@/lib/data/comments'
import {
  CommentMutationRolloutError,
  deleteOwnCommentWithRollout,
  updateOwnCommentWithRollout,
} from '@/lib/data/comment-mutation-rollout'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { getUserHandle } from '@/lib/supabase/server'
import logger, { fireAndForget } from '@/lib/logger'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'
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
const EditCommentSchema = z
  .object({
    comment_id: z.string().uuid('Invalid comment ID'),
    content: z
      .string()
      .trim()
      .min(1, 'Comment content is required')
      .max(2000, 'Comment must be at most 2000 characters'),
  })
  .strict()

// Zod schema for DELETE (delete comment)
const DeleteCommentSchema = z
  .object({
    comment_id: z.string().uuid('Invalid comment ID'),
  })
  .strict()

const PostIdSchema = z.string().uuid('Invalid post ID')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Extract post id from URL path */
function extractPostId(url: string): string | undefined {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return postsIdx >= 0 ? pathParts[postsIdx + 1] : undefined
}

function requirePostId(url: string): string {
  const parsed = PostIdSchema.safeParse(extractPostId(url))
  if (!parsed.success) throw ApiError.validation('Invalid post ID')
  return parsed.data
}

function databaseCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
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

type InteractablePost = {
  author_id: string
  group_id: string | null
  visibility: string
}

async function hasBidirectionalBlock(
  supabase: SupabaseClient,
  viewerId: string,
  authorId: string,
  operation: 'GET' | 'POST' | 'PUT'
): Promise<boolean> {
  if (viewerId === authorId) return false

  const { data: block, error: blocksError } = await supabase
    .from('blocked_users')
    .select('blocker_id, blocked_id')
    .or(
      `and(blocker_id.eq.${viewerId},blocked_id.eq.${authorId}),` +
        `and(blocker_id.eq.${authorId},blocked_id.eq.${viewerId})`
    )
    .limit(1)
    .maybeSingle()

  if (blocksError) {
    logger.error(`[comments ${operation}] Block permission lookup failed`, {
      code: blocksError.code,
    })
    throw ApiError.internal(
      operation === 'GET'
        ? 'Comments could not be loaded'
        : 'Comment permission could not be checked'
    )
  }

  return !!block
}

async function assertCanInteractWithPost(
  supabase: SupabaseClient,
  userId: string,
  post: InteractablePost,
  operation: 'POST' | 'PUT'
): Promise<void> {
  if (await hasBidirectionalBlock(supabase, userId, post.author_id, operation)) {
    throw ApiError.forbidden('You cannot interact with this user')
  }

  if (post.visibility === 'followers' && post.author_id !== userId) {
    const { data: follow, error: followError } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .eq('following_id', post.author_id)
      .maybeSingle()

    if (followError) {
      logger.error(`[comments ${operation}] Follower permission lookup failed`, {
        code: followError.code,
      })
      throw ApiError.internal('Comment permission could not be checked')
    }
    if (!follow) throw ApiError.forbidden('Only followers can interact with this post')
  } else if (post.visibility === 'group' && !post.group_id) {
    throw ApiError.forbidden('This group post is not available')
  } else if (!['public', 'followers', 'group'].includes(post.visibility)) {
    throw ApiError.forbidden('This post is not available')
  }

  // A legacy row may carry group_id while its visibility is still public. The
  // group resource remains authoritative for write permissions in that case.
  if (post.group_id) {
    const [
      { data: group, error: groupError },
      { data: membership, error: membershipError },
      { data: ban, error: banError },
    ] = await Promise.all([
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

    if (groupError || membershipError || banError) {
      logger.error(`[comments ${operation}] Group permission lookup failed`, {
        groupCode: groupError?.code,
        membershipCode: membershipError?.code,
        banCode: banError?.code,
      })
      throw ApiError.internal('Comment permission could not be checked')
    }
    if (!group || group.dissolved_at) {
      throw ApiError.forbidden('This group is read-only')
    }
    if (ban) throw ApiError.forbidden('You are banned from this group')
    if (!membership) throw ApiError.forbidden('You must be a member to interact in this group')
    if (membership.muted_until && new Date(membership.muted_until) > new Date()) {
      throw ApiError.forbidden('You have been muted')
    }
  }
}

export const GET = withPublic(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // Optional-auth reads must distinguish a genuinely anonymous request from
    // an expired/invalid bearer token. Returning 401 lets authedFetch refresh
    // once instead of silently degrading a member/follower to public access.
    if (request.headers.get('authorization') && !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const id = extractPostId(request.url)

    // Validate UUID format to prevent PostgreSQL cast errors
    if (!id || !UUID_RE.test(id)) {
      throw ApiError.notFound('Post not found')
    }

    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 50
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const sortParam = searchParams.get('sort')
    const sort: CommentSortMode = sortParam === 'time' ? 'time' : 'best'

    if (!(await canServiceActorReadPost(supabase, id, user?.id ?? null))) {
      throw ApiError.notFound('Post not found')
    }

    // withPublic uses a service-role client, so RLS cannot protect this read.
    // Resolve the parent post first and enforce the same visibility contract as
    // the post itself. Missing and inaccessible posts intentionally look alike.
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('id, author_id, group_id, visibility, status, comment_count')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (postError) {
      logger.error('[comments GET] Post visibility lookup failed', { code: postError.code })
      throw ApiError.internal('Comments could not be loaded')
    }

    if (post && user && (await hasBidirectionalBlock(supabase, user.id, post.author_id, 'GET'))) {
      throw ApiError.notFound('Post not found')
    }

    let canRead = !!post && post.status !== 'deleted' && post.visibility === 'public'
    if (post && post.status !== 'deleted' && user) {
      if (post.author_id === user.id) {
        canRead = true
      } else if (post.visibility === 'followers') {
        const { data: follow, error: followError } = await supabase
          .from('user_follows')
          .select('following_id')
          .eq('follower_id', user.id)
          .eq('following_id', post.author_id)
          .maybeSingle()

        if (followError) {
          logger.error('[comments GET] Follower visibility lookup failed', {
            code: followError.code,
          })
          throw ApiError.internal('Comments could not be loaded')
        }
        canRead = !!follow
      } else if (post.visibility === 'group' && post.group_id) {
        const { data: membership, error: membershipError } = await supabase
          .from('group_members')
          .select('user_id')
          .eq('group_id', post.group_id)
          .eq('user_id', user.id)
          .maybeSingle()

        if (membershipError) {
          logger.error('[comments GET] Group visibility lookup failed', {
            code: membershipError.code,
          })
          throw ApiError.internal('Comments could not be loaded')
        }
        canRead = !!membership
      }
    }

    if (!post || !canRead) {
      throw ApiError.notFound('Post not found')
    }

    // Fetch one look-ahead row so a full final page does not falsely claim
    // there is another page. Block filtering happens before this range.
    const commentsWithLookahead = await getPostComments(supabase, id, {
      limit: limit + 1,
      offset,
      userId: user?.id,
      sort,
    })
    const hasMore = commentsWithLookahead.length > limit
    const comments = commentsWithLookahead.slice(0, limit)

    if (!Number.isSafeInteger(post.comment_count) || post.comment_count < 0) {
      logger.error('[comments GET] Post returned an invalid canonical comment count', {
        postId: id,
      })
      throw ApiError.internal('Comments could not be loaded')
    }

    return successWithPagination(
      { comments, post: { comment_count: post.comment_count } },
      { limit, offset, has_more: hasMore }
    )
  },
  { name: 'posts/comments-get', rateLimit: 'read', readsAuth: true }
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

    if (!(await canServiceActorReadPost(supabase, id, user.id))) {
      throw ApiError.notFound('Post not found')
    }

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
      // Treat cross-post IDs as absent in this post, avoiding an existence leak.
      throw ApiError.notFound('Parent comment not found')
    }
    if (parentComment?.parent_id) {
      throw ApiError.validation('Replies may only target a top-level comment')
    }

    await assertCanInteractWithPost(supabase, user.id, post, 'POST')
    if (
      parentComment &&
      parentComment.user_id !== post.author_id &&
      (await hasBidirectionalBlock(supabase, user.id, parentComment.user_id, 'POST'))
    ) {
      throw ApiError.forbidden('You cannot reply to this user')
    }

    let comment
    try {
      comment = await createComment(supabase, user.id, {
        post_id: id,
        content,
        parent_id,
      })
    } catch (error: unknown) {
      const code = databaseCode(error)
      if (code === '42501') throw ApiError.forbidden('You cannot comment on this post')
      if (code === '23503') throw ApiError.notFound('Post or parent comment not found')
      if (code === '23514' || code === 'P0002') {
        throw new ApiError('Post or parent comment is no longer available', {
          code: ErrorCode.OPERATION_FAILED,
          statusCode: 409,
        })
      }
      logger.error('[comments POST] Insert failed', { code })
      throw ApiError.internal('Comment could not be created')
    }

    // Send comment notifications (truly fire-and-forget — don't block response)
    fireAndForget(
      (async () => {
        const userHandle = await getUserHandle(user.id, user.email ?? undefined)

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

    let body: unknown
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

    let body: unknown
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
