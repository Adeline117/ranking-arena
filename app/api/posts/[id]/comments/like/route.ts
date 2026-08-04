/**
 * 评论反应 API
 * POST /api/posts/<id>/comments/like - 点赞/点踩/取消评论反应
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { success } from '@/lib/api'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

const ReactionRequestSchema = z
  .object({
    comment_id: z.string().uuid('Invalid comment ID'),
    type: z.enum(['like', 'dislike']),
  })
  .strict()

const PostIdSchema = z.string().uuid('Invalid post ID')
const ActorIdSchema = z.string().uuid('Invalid actor ID')
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

type ReactionType = 'like' | 'dislike'

interface AtomicCommentReactionResult {
  action: 'added' | 'removed' | 'changed'
  liked: boolean
  disliked: boolean
  like_count: number
  dislike_count: number
  reaction: ReactionType | null
}

const ATOMIC_RESULT_KEYS = [
  'action',
  'dislike_count',
  'disliked',
  'like_count',
  'liked',
  'reaction',
] as const

function privateNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

/** Extract post id from /api/posts/<id>/comments/like. */
function extractPostId(url: string): string | undefined {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return postsIdx >= 0 ? pathParts[postsIdx + 1] : undefined
}

function isAtomicReactionResult(
  value: unknown,
  requestedReaction: ReactionType
): value is AtomicCommentReactionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const keys = Object.keys(result).sort()
  const expectedKeys = [...ATOMIC_RESULT_KEYS].sort()
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    return false
  }

  const validAction =
    result.action === 'added' || result.action === 'removed' || result.action === 'changed'
  const actionMatchesReaction =
    (result.action === 'removed' && result.reaction === null) ||
    (result.action !== 'removed' && result.reaction === requestedReaction)
  const reactionMatchesFlags =
    (result.reaction === 'like' && result.liked === true && result.disliked === false) ||
    (result.reaction === 'dislike' && result.liked === false && result.disliked === true) ||
    (result.reaction === null && result.liked === false && result.disliked === false)

  return (
    typeof result.liked === 'boolean' &&
    typeof result.disliked === 'boolean' &&
    !(result.liked && result.disliked) &&
    Number.isSafeInteger(result.like_count) &&
    (result.like_count as number) >= 0 &&
    Number.isSafeInteger(result.dislike_count) &&
    (result.dislike_count as number) >= 0 &&
    Object.prototype.hasOwnProperty.call(result, 'reaction') &&
    validAction &&
    actionMatchesReaction &&
    reactionMatchesFlags &&
    (result.reaction !== 'like' || (result.like_count as number) >= 1) &&
    (result.reaction !== 'dislike' || (result.dislike_count as number) >= 1)
  )
}

const authenticatedPost = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const postIdResult = PostIdSchema.safeParse(extractPostId(request.url))
    if (!postIdResult.success) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    const actorIdResult = ActorIdSchema.safeParse(user.id)
    if (!actorIdResult.success) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
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
    const postId = postIdResult.data.toLowerCase()
    const commentId = parsed.data.comment_id.toLowerCase()
    const actorId = actorIdResult.data.toLowerCase()
    const requestedReaction = parsed.data.type

    const { data, error } = await supabase.rpc('toggle_comment_reaction', {
      p_post_id: postId,
      p_comment_id: commentId,
      p_user_id: actorId,
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

    if (!isAtomicReactionResult(data, requestedReaction)) {
      logger.error('[comment reaction] atomic RPC returned an invalid result')
      return NextResponse.json({ error: 'Comment reaction failed' }, { status: 500 })
    }

    return success(
      {
        actor_id: actorId,
        post_id: postId,
        comment_id: commentId,
        operation: 'toggle' as const,
        requested_reaction: requestedReaction,
        action: data.action,
        reaction: data.reaction,
        liked: data.liked,
        disliked: data.disliked,
        like_count: data.like_count,
        dislike_count: data.dislike_count,
      },
      200,
      PRIVATE_NO_STORE_HEADERS
    )
  },
  { name: 'posts/comments-reaction', rateLimit: 'write' }
)

export async function POST(request: NextRequest): Promise<NextResponse> {
  return privateNoStore(await authenticatedPost(request))
}
