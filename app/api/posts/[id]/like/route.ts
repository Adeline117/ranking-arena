/**
 * 帖子点赞 API
 * POST /api/posts/[id]/like - 点赞/取消点赞
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { validateEnum, success } from '@/lib/api'
import { togglePostReaction, getPostById, PostInteractionMutationError } from '@/lib/data/posts'
import { sendNotification } from '@/lib/data/notifications'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getUserHandle } from '@/lib/supabase/server'
import { z } from 'zod'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  // Rate limit: prevent like-bombing
  const rl = await checkRateLimit(request, RateLimitPresets.write)
  if (rl) return rl

  const { id } = await context.params
  const parsedPostId = z.string().uuid().safeParse(id)
  if (!parsedPostId.success) {
    return NextResponse.json({ success: false, error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
      }

      const reactionType =
        validateEnum(body.reaction_type || 'up', ['up', 'down'] as const, {
          fieldName: 'reaction_type',
        }) ?? 'up'

      // 执行点赞/踩操作
      let result
      try {
        result = await togglePostReaction(supabase, parsedPostId.data, user.id, reactionType)
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

      if (result.action === 'added' && reactionType === 'up') {
        try {
          post = await getPostById(supabase, parsedPostId.data, user.id)
        } catch (fetchError) {
          logger.warn('[posts/[id]/like] Failed to fetch notification post:', fetchError)
        }
      }

      // Send like notification (fire-and-forget, deduped — same actor+post within 1h won't send again)
      if (
        result.action === 'added' &&
        reactionType === 'up' &&
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
                link: `/post/${parsedPostId.data}`,
                reference_id: parsedPostId.data,
                read: false,
              },
              'Like notification'
            )
          }),
          'Like notification setup'
        )
      }

      return success({
        action: result.action,
        reaction: result.reaction,
        like_count: result.like_count,
        dislike_count: result.dislike_count,
      })
    },
    { name: 'posts-like', rateLimit: 'write' }
  )

  return handler(request)
}
