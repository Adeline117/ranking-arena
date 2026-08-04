import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { success } from '@/lib/api'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import {
  COMMENT_REACTION_INTENT_OPERATION,
  isCanonicalCommentReactionIntentSequence,
  isCanonicalCommentReactionRequestId,
  type CommentReaction,
} from '@/lib/comments/comment-reaction-client-contract'

const IntentRequestSchema = z
  .object({
    operation: z.literal(COMMENT_REACTION_INTENT_OPERATION),
    request_id: z.string().refine(isCanonicalCommentReactionRequestId),
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

type AtomicFailureStatus =
  | 'stale'
  | 'expired'
  | 'unknown_ticket'
  | 'operation_conflict'
  | 'too_many_pending'
  | 'invalid'
  | 'not_found'

type AtomicIntentResult = {
  status: 'issued' | 'replayed'
  intent_sequence: string
  expires_at: string
}

const INTENT_RESULT_KEYS = ['expires_at', 'intent_sequence', 'status'] as const
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

function extractPostId(url: string): string | undefined {
  const pathParts = new URL(url).pathname.split('/')
  const postsIdx = pathParts.indexOf('posts')
  return postsIdx >= 0 ? pathParts[postsIdx + 1] : undefined
}

function hasCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const expectedKeys = [...expected].sort()
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  )
}

function isAtomicIntentResult(value: unknown): value is AtomicIntentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    hasExactKeys(result, INTENT_RESULT_KEYS) &&
    (result.status === 'issued' || result.status === 'replayed') &&
    isCanonicalCommentReactionIntentSequence(result.intent_sequence) &&
    hasCanonicalTimestamp(result.expires_at)
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

    const parsed = IntentRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid reaction intent request' }, { status: 400 })
    }

    const actorId = actorIdResult.data.toLowerCase()
    const postId = postIdResult.data.toLowerCase()
    const commentId = parsed.data.comment_id.toLowerCase()
    const requestId = parsed.data.request_id
    const desiredReaction: CommentReaction | null = parsed.data.desired_reaction

    const { data, error } = await supabase.rpc('reserve_comment_reaction_intent_atomic', {
      p_actor_id: actorId,
      p_post_id: postId,
      p_comment_id: commentId,
      p_request_id: requestId,
      p_desired_reaction: desiredReaction,
    })

    if (error) {
      logger.error('[comment reaction intent] atomic RPC failed', { code: error.code })
      if (error.code === 'P0002' || error.code === '23503') {
        return atomicFailureResponse('not_found')
      }
      if (error.code === '22023') return atomicFailureResponse('invalid')
      if (error.code === '23514' || error.code === '40001' || error.code === '40P01') {
        return atomicFailureResponse('operation_conflict')
      }
      if (error.code === '42501') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      return NextResponse.json({ error: 'Comment reaction intent failed' }, { status: 500 })
    }

    const failureStatus = atomicFailureStatus(data)
    if (failureStatus) return atomicFailureResponse(failureStatus)
    if (!isAtomicIntentResult(data)) {
      logger.error('[comment reaction intent] atomic RPC returned an invalid result')
      return NextResponse.json({ error: 'Comment reaction intent failed' }, { status: 500 })
    }

    return success(
      {
        actor_id: actorId,
        post_id: postId,
        comment_id: commentId,
        request_id: requestId,
        operation: COMMENT_REACTION_INTENT_OPERATION,
        desired_reaction: desiredReaction,
        status: data.status,
        intent_sequence: data.intent_sequence,
        expires_at: data.expires_at,
        replayed: data.status === 'replayed',
      },
      200,
      PRIVATE_NO_STORE_HEADERS
    )
  },
  { name: 'posts/comments-reaction-intent', rateLimit: 'write' }
)

export async function POST(request: NextRequest): Promise<NextResponse> {
  return privateNoStore(await authenticatedPost(request))
}
