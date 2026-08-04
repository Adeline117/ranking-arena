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
import {
  COMMENT_REACTION_OPERATION,
  isCanonicalCommentReactionIntentSequence,
  isCanonicalCommentReactionRequestId,
  type CommentReaction,
} from '@/lib/comments/comment-reaction-client-contract'

const ReactionRequestSchema = z
  .object({
    operation: z.literal(COMMENT_REACTION_OPERATION),
    request_id: z.string().refine(isCanonicalCommentReactionRequestId),
    intent_sequence: z.string().refine(isCanonicalCommentReactionIntentSequence),
    comment_id: z.string().uuid('Invalid comment ID'),
    desired_reaction: z.enum(['like', 'dislike']).nullable(),
  })
  .strict()

const PostIdSchema = z.string().uuid('Invalid post ID')
const ActorIdSchema = z.string().uuid('Invalid actor ID')
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

interface AtomicCommentReactionResult {
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  action: 'added' | 'removed' | 'changed' | 'unchanged'
  liked: boolean
  disliked: boolean
  like_count: number
  dislike_count: number
  reaction: CommentReaction | null
  intent_sequence: string
  replayed: boolean
}

const ATOMIC_RESULT_KEYS = [
  'action',
  'dislike_count',
  'disliked',
  'like_count',
  'liked',
  'reaction',
  'intent_sequence',
  'replayed',
  'status',
] as const

type AtomicFailureStatus =
  | 'stale'
  | 'expired'
  | 'unknown_ticket'
  | 'operation_conflict'
  | 'too_many_pending'
  | 'invalid'
  | 'not_found'

const FAILURE_HTTP: Record<AtomicFailureStatus, { status: number; code: string; error: string }> = {
  stale: { status: 409, code: 'COMMENT_REACTION_STALE', error: 'Reaction intent is stale' },
  expired: { status: 410, code: 'COMMENT_REACTION_EXPIRED', error: 'Reaction intent expired' },
  unknown_ticket: {
    status: 409,
    code: 'COMMENT_REACTION_UNKNOWN_TICKET',
    error: 'Reaction intent is unknown',
  },
  operation_conflict: {
    status: 409,
    code: 'COMMENT_REACTION_OPERATION_CONFLICT',
    error: 'Reaction intent conflicts with an existing operation',
  },
  too_many_pending: {
    status: 429,
    code: 'COMMENT_REACTION_TOO_MANY_PENDING',
    error: 'Too many pending reaction intents',
  },
  invalid: {
    status: 400,
    code: 'COMMENT_REACTION_INVALID',
    error: 'Invalid reaction request',
  },
  not_found: {
    status: 404,
    code: 'COMMENT_REACTION_NOT_FOUND',
    error: 'Comment not found',
  },
}

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
  desiredReaction: CommentReaction | null,
  intentSequence: string
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
    result.action === 'added' ||
    result.action === 'removed' ||
    result.action === 'changed' ||
    result.action === 'unchanged'
  const actionMatchesDesired =
    (result.action === 'removed' && desiredReaction === null) ||
    ((result.action === 'added' || result.action === 'changed') && desiredReaction !== null) ||
    result.action === 'unchanged'
  const reactionMatchesFlags =
    (result.reaction === 'like' && result.liked === true && result.disliked === false) ||
    (result.reaction === 'dislike' && result.liked === false && result.disliked === true) ||
    (result.reaction === null && result.liked === false && result.disliked === false)

  return (
    typeof result.liked === 'boolean' &&
    typeof result.disliked === 'boolean' &&
    typeof result.replayed === 'boolean' &&
    isCanonicalCommentReactionIntentSequence(result.intent_sequence) &&
    result.intent_sequence === intentSequence &&
    !(result.liked && result.disliked) &&
    Number.isSafeInteger(result.like_count) &&
    (result.like_count as number) >= 0 &&
    Number.isSafeInteger(result.dislike_count) &&
    (result.dislike_count as number) >= 0 &&
    Object.prototype.hasOwnProperty.call(result, 'reaction') &&
    validAction &&
    result.status === result.action &&
    actionMatchesDesired &&
    result.reaction === desiredReaction &&
    reactionMatchesFlags &&
    (result.reaction !== 'like' || (result.like_count as number) >= 1) &&
    (result.reaction !== 'dislike' || (result.dislike_count as number) >= 1)
  )
}

function atomicFailureStatus(value: unknown): AtomicFailureStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  const keys = Object.keys(result)
  if (keys.length !== 1 || keys[0] !== 'status') return null
  return Object.prototype.hasOwnProperty.call(FAILURE_HTTP, String(result.status))
    ? (result.status as AtomicFailureStatus)
    : null
}

function atomicFailureResponse(failure: AtomicFailureStatus): NextResponse {
  const mapped = FAILURE_HTTP[failure]
  return NextResponse.json(
    { success: false, code: mapped.code, error: mapped.error },
    { status: mapped.status }
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

    // Every mutation crosses one transactional authorization/desired-state/
    // counter boundary. A missing function is a deployment error and must
    // never reopen legacy direct table writes.
    const postId = postIdResult.data.toLowerCase()
    const commentId = parsed.data.comment_id.toLowerCase()
    const actorId = actorIdResult.data.toLowerCase()
    const requestId = parsed.data.request_id
    const intentSequence = parsed.data.intent_sequence
    const desiredReaction = parsed.data.desired_reaction

    const { data, error } = await supabase.rpc('set_comment_reaction_desired_state_causal_atomic', {
      p_actor_id: actorId,
      p_post_id: postId,
      p_comment_id: commentId,
      p_request_id: requestId,
      p_desired_reaction: desiredReaction,
      p_intent_sequence: intentSequence,
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

    const failureStatus = atomicFailureStatus(data)
    if (failureStatus) return atomicFailureResponse(failureStatus)

    if (!isAtomicReactionResult(data, desiredReaction, intentSequence)) {
      logger.error('[comment reaction] atomic RPC returned an invalid result')
      return NextResponse.json({ error: 'Comment reaction failed' }, { status: 500 })
    }

    return success(
      {
        actor_id: actorId,
        post_id: postId,
        comment_id: commentId,
        request_id: requestId,
        operation: COMMENT_REACTION_OPERATION,
        intent_sequence: data.intent_sequence,
        desired_reaction: desiredReaction,
        action: data.action,
        reaction: data.reaction,
        liked: data.liked,
        disliked: data.disliked,
        like_count: data.like_count,
        dislike_count: data.dislike_count,
        replayed: data.replayed,
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
