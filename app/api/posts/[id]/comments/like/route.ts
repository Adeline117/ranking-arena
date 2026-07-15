/**
 * 评论反应 API
 * POST /api/posts/[id]/comments/like - 点赞/点踩/取消评论反应
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { success } from '@/lib/api'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

const ReactionRequestSchema = z
  .object({
    comment_id: z.string().uuid('Invalid comment ID'),
    // Keep the historical omission-as-like contract while rejecting every
    // other value instead of silently coercing it to a like.
    type: z.enum(['like', 'dislike']).optional().default('like'),
  })
  .strict()

const PostIdSchema = z.string().uuid('Invalid post ID')

type ReactionType = 'like' | 'dislike'

interface DatabaseError {
  code?: string
}

interface CommentReactionResult {
  liked: boolean
  disliked: boolean
  like_count: number
  dislike_count: number
  reaction?: ReactionType | null
}

/** Extract post id from /api/posts/<id>/comments/like. */
function extractPostId(url: string): string | undefined {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return postsIdx >= 0 ? pathParts[postsIdx + 1] : undefined
}

function isReactionResult(
  value: unknown,
  requestedReaction: ReactionType
): value is CommentReactionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const hasReaction = Object.prototype.hasOwnProperty.call(result, 'reaction')
  const validReaction = result.reaction === null || result.reaction === requestedReaction
  const reactionMatchesFlags =
    (result.reaction === 'like' && result.liked === true && result.disliked === false) ||
    (result.reaction === 'dislike' && result.liked === false && result.disliked === true) ||
    (result.reaction === null && result.liked === false && result.disliked === false)

  return (
    typeof result.liked === 'boolean' &&
    typeof result.disliked === 'boolean' &&
    !(result.liked && result.disliked) &&
    Number.isInteger(result.like_count) &&
    (result.like_count as number) >= 0 &&
    Number.isInteger(result.dislike_count) &&
    (result.dislike_count as number) >= 0 &&
    hasReaction &&
    validReaction &&
    reactionMatchesFlags
  )
}

function isMissingReactionRpc(error: DatabaseError): boolean {
  // PGRST202 is PostgREST's schema-cache miss. 42883 is PostgreSQL's
  // undefined_function. No message/status matching: every other failure must
  // stay on the atomic path and fail closed.
  return error.code === 'PGRST202' || error.code === '42883'
}

function databaseFailure(stage: string, error?: DatabaseError) {
  logger.error('[comment reaction] legacy bridge failed', {
    stage,
    ...(error?.code ? { code: error.code } : {}),
  })
  return NextResponse.json({ error: 'Comment reaction failed' }, { status: 500 })
}

function mutationFailure(error: DatabaseError) {
  logger.error('[comment reaction] legacy source mutation failed', { code: error.code })
  const status =
    error.code === '23505' || error.code === '40001' || error.code === '40P01' ? 409 : 500
  return NextResponse.json(
    { error: status === 409 ? 'Comment reaction could not be applied' : 'Comment reaction failed' },
    { status }
  )
}

/**
 * Temporary old-schema bridge for zero-downtime rollout.
 *
 * This path intentionally remains strict even though the legacy schema cannot
 * make the whole toggle one transaction. It validates the route resource and
 * audience, checks every read/write error, recounts from source with exact
 * counts, requires the cached-counter write to acknowledge those exact values,
 * and verifies the user's final source row before returning 2xx.
 */
async function toggleCommentReactionLegacy(
  supabase: SupabaseClient,
  postId: string,
  commentId: string,
  userId: string,
  reactionType: ReactionType
) {
  const { data: post, error: postError } = await supabase
    .from('posts')
    .select('id, author_id, visibility, group_id, status, deleted_at')
    .eq('id', postId)
    .maybeSingle()

  if (postError) return databaseFailure('post-read', postError)
  if (!post || post.deleted_at || post.status !== 'active') {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  const { data: comment, error: commentError } = await supabase
    .from('comments')
    .select('id, post_id, user_id, deleted_at')
    .eq('id', commentId)
    .maybeSingle()

  if (commentError) return databaseFailure('comment-read', commentError)
  if (!comment || comment.post_id !== postId || comment.deleted_at) {
    return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
  }

  const { data: existing, error: existingError } = await supabase
    .from('comment_likes')
    .select('id, reaction_type')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) return databaseFailure('source-read', existingError)

  const existingType: ReactionType | null = existing
    ? existing.reaction_type === 'dislike'
      ? 'dislike'
      : 'like'
    : null
  const expectedReaction = existingType === reactionType ? null : reactionType
  const isRemoval = expectedReaction === null

  // A user must always be able to remove an existing reaction. Blocks,
  // follower edges, and group membership can change after it was created; they
  // gate only a new reaction or a switch to the other type.
  if (!isRemoval) {
    const { data: blocked, error: blockedError } = await supabase
      .from('blocked_users')
      .select('blocker_id')
      .or(
        `and(blocker_id.eq.${userId},blocked_id.eq.${post.author_id}),` +
          `and(blocker_id.eq.${post.author_id},blocked_id.eq.${userId}),` +
          `and(blocker_id.eq.${userId},blocked_id.eq.${comment.user_id}),` +
          `and(blocker_id.eq.${comment.user_id},blocked_id.eq.${userId})`
      )
      .limit(1)
      .maybeSingle()

    if (blockedError) return databaseFailure('block-read', blockedError)
    if (blocked) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    if (post.group_id) {
      const [groupResult, banResult, membershipResult] = await Promise.all([
        supabase.from('groups').select('id, dissolved_at').eq('id', post.group_id).maybeSingle(),
        supabase
          .from('group_bans')
          .select('user_id')
          .eq('group_id', post.group_id)
          .eq('user_id', userId)
          .maybeSingle(),
        supabase
          .from('group_members')
          .select('user_id')
          .eq('group_id', post.group_id)
          .eq('user_id', userId)
          .maybeSingle(),
      ])

      if (groupResult.error) return databaseFailure('group-read', groupResult.error)
      if (banResult.error) return databaseFailure('group-ban-read', banResult.error)
      if (membershipResult.error) {
        return databaseFailure('group-membership-read', membershipResult.error)
      }
      // Dissolved groups retain readable history, but cannot receive a new or
      // switched reaction. Removal stays allowed through the branch above.
      if (
        !groupResult.data ||
        groupResult.data.dissolved_at ||
        banResult.data ||
        !membershipResult.data
      ) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } else if (post.visibility === 'followers') {
      if (post.author_id !== userId) {
        const { data: follows, error: followsError } = await supabase
          .from('user_follows')
          .select('follower_id')
          .eq('follower_id', userId)
          .eq('following_id', post.author_id)
          .maybeSingle()

        if (followsError) return databaseFailure('follow-read', followsError)
        if (!follows) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    } else if (post.visibility !== 'public') {
      // Includes malformed legacy `group` rows without a group_id.
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  let mutationError: DatabaseError | null = null
  if (existing && existingType === reactionType) {
    const { error } = await supabase
      .from('comment_likes')
      .delete()
      .eq('id', existing.id)
      .eq('comment_id', commentId)
      .eq('user_id', userId)
    mutationError = error
  } else if (existing) {
    const { error } = await supabase
      .from('comment_likes')
      .update({ reaction_type: reactionType })
      .eq('id', existing.id)
      .eq('comment_id', commentId)
      .eq('user_id', userId)
    mutationError = error
  } else {
    const { error } = await supabase.from('comment_likes').insert({
      comment_id: commentId,
      user_id: userId,
      reaction_type: reactionType,
    })
    mutationError = error
  }

  if (mutationError) return mutationFailure(mutationError)

  const [likeResult, dislikeResult] = await Promise.all([
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

  if (likeResult.error) return databaseFailure('like-recount', likeResult.error)
  if (dislikeResult.error) return databaseFailure('dislike-recount', dislikeResult.error)
  if (
    !Number.isInteger(likeResult.count) ||
    (likeResult.count as number) < 0 ||
    !Number.isInteger(dislikeResult.count) ||
    (dislikeResult.count as number) < 0
  ) {
    return databaseFailure('invalid-recount')
  }

  const likeCount = likeResult.count as number
  const dislikeCount = dislikeResult.count as number
  const { data: updatedComment, error: counterError } = await supabase
    .from('comments')
    .update({ like_count: likeCount, dislike_count: dislikeCount })
    .eq('id', commentId)
    .eq('post_id', postId)
    .is('deleted_at', null)
    .select('id, like_count, dislike_count')
    .maybeSingle()

  if (counterError) return databaseFailure('counter-update', counterError)
  if (
    !updatedComment ||
    updatedComment.like_count !== likeCount ||
    updatedComment.dislike_count !== dislikeCount
  ) {
    return databaseFailure('counter-ack')
  }

  const { data: finalSource, error: finalSourceError } = await supabase
    .from('comment_likes')
    .select('reaction_type')
    .eq('comment_id', commentId)
    .eq('user_id', userId)
    .maybeSingle()

  if (finalSourceError) return databaseFailure('source-ack', finalSourceError)
  const finalReaction: ReactionType | null = finalSource
    ? finalSource.reaction_type === 'dislike'
      ? 'dislike'
      : 'like'
    : null

  if (finalReaction !== expectedReaction) {
    logger.warn('[comment reaction] legacy bridge lost a concurrent toggle race')
    return NextResponse.json({ error: 'Comment reaction could not be applied' }, { status: 409 })
  }

  return success({
    liked: finalReaction === 'like',
    disliked: finalReaction === 'dislike',
    like_count: likeCount,
    dislike_count: dislikeCount,
    reaction: finalReaction,
  })
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postIdResult = PostIdSchema.safeParse(extractPostId(request.url))
    if (!postIdResult.success) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const parsed = ReactionRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid reaction request' }, { status: 400 })
    }

    // New schemas provide one transaction for validation, toggle, counters and
    // final truth. The legacy bridge below is selected only for an objectively
    // missing function during the short migration rollout window.
    const { data, error } = await supabase.rpc('toggle_comment_reaction', {
      p_post_id: postIdResult.data,
      p_comment_id: parsed.data.comment_id,
      p_user_id: user.id,
      p_reaction_type: parsed.data.type,
    })

    if (error) {
      if (isMissingReactionRpc(error)) {
        logger.warn('[comment reaction] atomic RPC missing; using rollout bridge', {
          code: error.code,
        })
        return toggleCommentReactionLegacy(
          supabase,
          postIdResult.data,
          parsed.data.comment_id,
          user.id,
          parsed.data.type
        )
      }

      logger.error('[comment reaction] atomic RPC failed', { code: error.code })
      if (error.code === 'P0002' || error.code === '23503') {
        return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
      }
      if (error.code === '22023') {
        return NextResponse.json({ error: 'Invalid reaction request' }, { status: 400 })
      }
      if (error.code === '23514' || error.code === '40001' || error.code === '40P01') {
        return NextResponse.json(
          { error: 'Comment reaction could not be applied' },
          { status: 409 }
        )
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Comment reaction failed' }, { status: 500 })
    }

    if (!isReactionResult(data, parsed.data.type)) {
      logger.error('[comment reaction] atomic RPC returned an invalid result')
      return NextResponse.json({ error: 'Comment reaction failed' }, { status: 500 })
    }

    return success({
      liked: data.liked,
      disliked: data.disliked,
      like_count: data.like_count,
      dislike_count: data.dislike_count,
      ...(data.reaction !== undefined ? { reaction: data.reaction } : {}),
    })
  },
  { name: 'posts/comments-reaction', rateLimit: 'write' }
)
