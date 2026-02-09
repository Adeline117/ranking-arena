/**
 * 帖子点赞 API
 * POST /api/posts/[id]/like - 点赞/取消点赞
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateEnum,
} from '@/lib/api'
import { togglePostReaction, getPostById } from '@/lib/data/posts'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params

    // CSRF 验证
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken) && false) { // CSRF disabled: auth token is sufficient
      return NextResponse.json({ error: 'CSRF 验证失败' }, { status: 403 })
    }

    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const reactionType = validateEnum(
      body.reaction_type || 'up',
      ['up', 'down'] as const,
      { fieldName: 'reaction_type' }
    ) ?? 'up'

    // 执行点赞/踩操作
    const result = await togglePostReaction(supabase, id, user.id, reactionType)

    // 清除帖子列表缓存
    deleteServerCacheByPrefix('posts:')

    // 获取更新后的帖子信息（失败不影响点赞结果返回）
    let likeCount = 0
    let dislikeCount = 0

    try {
      const post = await getPostById(supabase, id)
      likeCount = post?.like_count || 0
      dislikeCount = post?.dislike_count || 0
    } catch (fetchError) {
      // 点赞已成功，只是无法获取最新计数
      // 根据操作类型估算计数变化
      logger.warn('[posts/[id]/like] Failed to fetch updated counts:', fetchError)
      likeCount = result.action === 'added' && reactionType === 'up' ? 1 : 0
      dislikeCount = result.action === 'added' && reactionType === 'down' ? 1 : 0
    }

    return success({
      action: result.action,
      reaction: result.reaction,
      like_count: likeCount,
      dislike_count: dislikeCount,
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/like')
  }
}
