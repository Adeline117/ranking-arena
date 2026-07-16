/**
 * 评论反应 API
 * POST /api/posts/<id>/comments/like - 点赞/点踩/取消评论反应
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { success } from '@/lib/api'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

const ReactionRequestSchema = z
  .object({
    comment_id: z.string().uuid('Invalid comment ID'),
    type: z.enum(['like', 'dislike']).optional().default('like'),
  })
  .strict()

const PostIdSchema = z.string().uuid('Invalid post ID')

type ReactionType = 'like' | 'dislike'

interface CommentReactionResult {
  liked: boolean
  disliked: boolean
  like_count: number
  dislike_count: number
  reaction: ReactionType | null
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
    Object.prototype.hasOwnProperty.call(result, 'reaction') &&
    validReaction &&
    reactionMatchesFlags
  )
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

    // The expand migration is deployed. Every mutation now crosses the one
    // transactional authorization/toggle/counter boundary; a missing function
    // is a deployment error and must never reopen legacy direct table writes.
    const { data, error } = await supabase.rpc('toggle_comment_reaction', {
      p_post_id: postIdResult.data,
      p_comment_id: parsed.data.comment_id,
      p_user_id: user.id,
      p_reaction_type: parsed.data.type,
    })

    if (error) {
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
      reaction: data.reaction,
    })
  },
  { name: 'posts/comments-reaction', rateLimit: 'write' }
)
