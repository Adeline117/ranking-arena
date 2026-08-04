/**
 * 帖子投票 API
 * POST /api/posts/[id]/vote - 投票（看涨/看跌/观望）
 */

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { PostInteractionMutationError, setPostVoteDesiredState } from '@/lib/data/posts'
import { socialFeatureGuard } from '@/lib/features'
import {
  POST_BUILT_IN_VOTE_OPERATION,
  isCanonicalPostVoteRequestId,
} from '@/lib/polls/post-vote-client-contract'

// Zod schema for POST /api/posts/[id]/vote
const PostVoteSchema = z
  .object({
    operation: z.literal(POST_BUILT_IN_VOTE_OPERATION),
    request_id: z.string().refine(isCanonicalPostVoteRequestId),
    desired_choice: z
      .enum(['bull', 'bear', 'wait'], {
        message: 'desired_choice must be bull, bear, wait, or null',
      })
      .nullable(),
  })
  .strict()

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  return response
}

const postVoteHandler = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return privateNoStore(guard)

    // Extract post id from URL path
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    const postsIdx = pathParts.indexOf('posts')
    const id = pathParts[postsIdx + 1]

    const postId = z.string().uuid().safeParse(id)
    if (!postId.success) {
      return privateNoStore(NextResponse.json({ error: 'Invalid post ID' }, { status: 400 }))
    }
    const actorId = z.string().uuid().safeParse(user.id)
    if (!actorId.success) throw new Error('Authenticated vote actor is malformed')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return privateNoStore(NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }))
    }

    const parsed = PostVoteSchema.safeParse(body)
    if (!parsed.success) {
      return privateNoStore(
        NextResponse.json(
          { error: 'Invalid input', details: parsed.error.flatten() },
          { status: 400 }
        )
      )
    }
    const { desired_choice: desiredChoice, request_id: requestId } = parsed.data

    // Converge to the requested state; retrying the same command cannot toggle it away.
    let result
    try {
      result = await setPostVoteDesiredState(
        supabase,
        postId.data.toLowerCase(),
        actorId.data.toLowerCase(),
        desiredChoice
      )
    } catch (error) {
      if (error instanceof PostInteractionMutationError) {
        if (error.kind === 'not_found') {
          return privateNoStore(NextResponse.json({ error: 'Post not found' }, { status: 404 }))
        }
        if (error.kind === 'invalid') {
          return privateNoStore(
            NextResponse.json({ error: 'Invalid vote request' }, { status: 400 })
          )
        }
      }
      throw error
    }

    return privateNoStore(
      NextResponse.json({
        actor_id: actorId.data.toLowerCase(),
        post_id: postId.data.toLowerCase(),
        request_id: requestId,
        operation: POST_BUILT_IN_VOTE_OPERATION,
        desired_choice: desiredChoice,
        action: result.action,
        vote: result.vote,
        poll: result.poll,
      })
    )
  },
  { name: 'posts/vote', rateLimit: 'write' }
)

export async function POST(request: NextRequest): Promise<NextResponse> {
  return privateNoStore(await postVoteHandler(request))
}
