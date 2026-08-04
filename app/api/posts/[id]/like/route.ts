/**
 * 帖子点赞 API
 * POST /api/posts/[id]/like - 收敛到明确的点赞/踩/无反应状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api'
import {
  setPostReactionDesiredState,
  getPostById,
  PostInteractionMutationError,
} from '@/lib/data/posts'
import { sendNotification } from '@/lib/data/notifications'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getUserHandle } from '@/lib/supabase/server'
import { z } from 'zod'
import {
  POST_REACTION_OPERATION,
  isCanonicalPostReactionRequestId,
} from '@/lib/posts/post-reaction-client-contract'

type RouteContext = { params: Promise<{ id: string }> }

const uuidSchema = z.string().uuid()
const reactionRequestSchema = z
  .object({
    operation: z.literal(POST_REACTION_OPERATION),
    request_id: z.string().refine(isCanonicalPostReactionRequestId),
    desired_reaction: z.enum(['up', 'down']).nullable(),
  })
  .strict()
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

function privateNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return privateNoStore(guard)

  const { id } = await context.params
  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      const parsedPostId = uuidSchema.safeParse(id)
      if (!parsedPostId.success) {
        return NextResponse.json({ success: false, error: 'Invalid post ID' }, { status: 400 })
      }

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
      }

      const parsedBody = reactionRequestSchema.safeParse(body)
      if (!parsedBody.success) {
        return NextResponse.json(
          { success: false, error: 'Invalid reaction request' },
          { status: 400 }
        )
      }
      const parsedActorId = uuidSchema.safeParse(user.id)
      if (!parsedActorId.success) {
        return NextResponse.json(
          { success: false, error: 'Authentication failed' },
          { status: 401 }
        )
      }

      const desiredReaction = parsedBody.data.desired_reaction
      const requestId = parsedBody.data.request_id
      const actorId = parsedActorId.data.toLowerCase()
      const postId = parsedPostId.data.toLowerCase()

      // 执行点赞/踩操作
      let result
      try {
        result = await setPostReactionDesiredState(supabase, postId, actorId, desiredReaction)
      } catch (error) {
        if (error instanceof PostInteractionMutationError) {
          if (error.kind === 'not_found') {
            return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 })
          }
          if (error.kind === 'invalid') {
            return NextResponse.json(
              { success: false, error: 'Invalid reaction request' },
              { status: 400 }
            )
          }
        }
        throw error
      }

      // 清除帖子列表缓存
      deleteServerCacheByPrefix('posts:')

      // Fetch payload only when a notification may be emitted. The atomic RPC
      // already returned source-of-truth counters in its strict acknowledgement.
      let post: Awaited<ReturnType<typeof getPostById>> = null

      if (result.action !== 'unchanged' && result.reaction === 'up') {
        try {
          post = await getPostById(supabase, postId, actorId)
        } catch (fetchError) {
          logger.warn('[posts/[id]/like] Failed to fetch notification post:', fetchError)
        }
      }

      // Send like notification (fire-and-forget, deduped — same actor+post within 1h won't send again)
      if (
        result.action !== 'unchanged' &&
        result.reaction === 'up' &&
        post?.author_id &&
        post.author_id !== user.id
      ) {
        fireAndForget(
          getUserHandle(user.id, user.email ?? undefined).then((userHandle) => {
            sendNotification(
              supabase,
              {
                user_id: post!.author_id,
                type: 'like',
                title: `${userHandle} liked your post`,
                message: (post!.title || '').slice(0, 100) || 'your post',
                actor_id: user.id,
                link: `/post/${postId}`,
                reference_id: postId,
                read: false,
              },
              'Like notification'
            )
          }),
          'Like notification setup'
        )
      }

      return success(
        {
          actor_id: actorId,
          post_id: postId,
          request_id: requestId,
          operation: POST_REACTION_OPERATION,
          desired_reaction: desiredReaction,
          action: result.action,
          reaction: result.reaction,
          like_count: result.like_count,
          dislike_count: result.dislike_count,
        },
        200,
        PRIVATE_NO_STORE_HEADERS
      )
    },
    { name: 'posts-like', rateLimit: 'write' }
  )

  return privateNoStore(await handler(request))
}
