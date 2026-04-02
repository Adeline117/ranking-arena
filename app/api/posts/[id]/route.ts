/**
 * 单个帖子 API
 * GET /api/posts/[id] - 获取帖子详情
 * PUT /api/posts/[id] - 更新帖子
 * DELETE /api/posts/[id] - 删除帖子
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  success,
  notFound,
  handleError,
  validateString,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getPostById, updatePost, deletePost, getUserPostReaction, getUserPostVote } from '@/lib/data/posts'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { id } = await context.params

    // Validate UUID format to prevent PostgreSQL cast errors
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(id)) {
      return notFound('Post not found')
    }

    const supabase = getSupabaseAdmin()

    const post = await getPostById(supabase, id)
    if (!post) {
      return notFound('Post not found')
    }

    // 增加浏览次数（使用原子操作，不阻塞响应）
    Promise.resolve(supabase.rpc('increment_view_count', { post_id: id }))
      .then(({ error }) => {
        if (error) {
          // 回退到非原子操作
          Promise.resolve(
            supabase
              .from('posts')
              .update({ view_count: (post.view_count || 0) + 1 })
              .eq('id', id)
          ).then(({ error: fallbackError }) => {
            if (fallbackError) {
              logger.error('[posts/[id]] Failed to increment view count:', fallbackError.message)
            }
          }).catch((err: unknown) => {
            logger.error('[posts/[id]] Fallback view count error:', err)
          })
        }
      })
      .catch((err: unknown) => {
        logger.error('[posts/[id]] RPC view count error:', err)
      })

    // 如果用户已登录，获取用户的点赞和投票状态
    let user_reaction: 'up' | 'down' | null = null
    let user_vote: 'bull' | 'bear' | 'wait' | null = null

    const user = await getAuthUser(request)
    if (user) {
      user_reaction = await getUserPostReaction(supabase, id, user.id)
      user_vote = await getUserPostVote(supabase, id, user.id)
    }

    return success({
      post: {
        ...post,
        user_reaction,
        user_vote,
      },
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id] GET')
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const title = validateString(body.title, { maxLength: 200, fieldName: 'title' })
    const content = validateString(body.content, { maxLength: 10000, fieldName: 'content' })
    const poll_enabled = typeof body.poll_enabled === 'boolean' ? body.poll_enabled : undefined

    const post = await updatePost(supabase, id, user.id, {
      ...(title ? { title } : {}),
      ...(content ? { content } : {}),
      ...(poll_enabled !== undefined ? { poll_enabled } : {}),
    })

    return success({ post })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id] PUT')
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    await deletePost(supabase, id, user.id)

    return success({ message: 'Delete successful' })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id] DELETE')
  }
}
