/**
 * 帖子点赞 API
 * POST /api/posts/[id]/like - 点赞/取消点赞
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { validateEnum, success, handleError } from '@/lib/api'
import { togglePostReaction, getPostById } from '@/lib/data/posts'
import { createNotificationDeduped } from '@/lib/data/notifications'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getUserHandle } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id } = await context.params

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
      }

      const reactionType = validateEnum(
        body.reaction_type || 'up',
        ['up', 'down'] as const,
        { fieldName: 'reaction_type' }
      ) ?? 'up'

      // 执行点赞/踩操作
      const result = await togglePostReaction(supabase, id, user.id, reactionType)

      // 清除帖子列表缓存
      deleteServerCacheByPrefix('posts:')

      // 获取更新后的帖子信息（一次查询，同时用于计数和通知）
      let likeCount: number | null = 0
      let dislikeCount: number | null = 0
      let post: Awaited<ReturnType<typeof getPostById>> = null

      try {
        post = await getPostById(supabase, id)
        likeCount = post?.like_count || 0
        dislikeCount = post?.dislike_count || 0
      } catch (fetchError) {
        // Reaction saved but couldn't fetch actual counts.
        // Return null so client keeps its optimistic count instead of wrong "1".
        logger.warn('[posts/[id]/like] Failed to fetch updated counts:', fetchError)
        likeCount = null
        dislikeCount = null
      }

      // Send like notification (fire-and-forget, deduped — same actor+post within 1h won't send again)
      if (result.action === 'added' && reactionType === 'up' && post?.author_id && post.author_id !== user.id) {
        getUserHandle(user.id, user.email ?? undefined)
          .then(userHandle => {
            createNotificationDeduped(supabase, {
              user_id: post!.author_id,
              type: 'like',
              title: `${userHandle} liked your post`,
              message: (post!.title || '').slice(0, 100) || 'your post',
              actor_id: user.id,
              link: `/post/${id}`,
              reference_id: id,
              read: false,
            })
          })
          .catch(notifErr => {
            logger.warn('[posts/[id]/like] Notification error:', notifErr)
          })
      }

      return success({
        action: result.action,
        reaction: result.reaction,
        like_count: likeCount,
        dislike_count: dislikeCount,
      })
    },
    { name: 'posts-like', rateLimit: 'write' }
  )

  return handler(request)
}
