/**
 * 单个帖子 API
 * GET /api/posts/[id] - 获取帖子详情
 * PUT /api/posts/[id] - 更新帖子
 * DELETE /api/posts/[id] - 删除帖子
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getOptionalAuthUser,
  requireAuth,
  success,
  notFound,
  handleError,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getPostById, deletePost, getUserPostReaction, getUserPostVote } from '@/lib/data/posts'
import { updateCount } from '@/lib/services/counters'
import { socialFeatureGuard } from '@/lib/features'
import { handleAtomicPostEditHttp } from '@/lib/posts/post-edit-server'

type RouteContext = { params: Promise<{ id: string }> }

function privateNoStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0')
  response.headers.set('CDN-Cache-Control', 'no-store')
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  const vary = new Set(
    (response.headers.get('Vary') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  )
  vary.add('Authorization')
  response.headers.set('Vary', [...vary].join(', '))
  return response
}

export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return privateNoStore(guard)

  try {
    const { id } = await context.params

    // Validate UUID format to prevent PostgreSQL cast errors
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(id)) {
      return privateNoStore(notFound('Post not found'))
    }

    const supabase = getSupabaseAdmin()
    const user = await getOptionalAuthUser(request)

    const post = await getPostById(supabase, id, user?.id)
    if (!post) {
      return privateNoStore(notFound('Post not found'))
    }

    // 增加浏览次数（fire-and-forget，原子操作）
    updateCount(supabase, 'increment_view_count', { post_id: id }, 'Increment view count')

    // 如果用户已登录，并行获取用户的点赞和投票状态
    let user_reaction: 'up' | 'down' | null = null
    let user_vote: 'bull' | 'bear' | 'wait' | null = null

    if (user) {
      const [reaction, vote] = await Promise.all([
        getUserPostReaction(supabase, id, user.id),
        getUserPostVote(supabase, id, user.id),
      ])
      user_reaction = reaction
      user_vote = vote
    }

    return privateNoStore(
      success({
        post: {
          ...post,
          user_reaction,
          user_vote,
        },
      })
    )
  } catch (error: unknown) {
    return privateNoStore(handleError(error, 'posts/[id] GET'))
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
    return handleAtomicPostEditHttp({
      request,
      supabase,
      actorId: user.id,
      postId: id,
      envelope: 'standard',
    })
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

    const deleted = await deletePost(supabase, id, user.id)
    if (!deleted) {
      // 0 rows matched: post doesn't exist or caller isn't the author.
      // Surface it instead of a fake 200 (silent no-op left QA canary posts live).
      return notFound('Post not found')
    }

    return success({ message: 'Delete successful' })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id] DELETE')
  }
}
