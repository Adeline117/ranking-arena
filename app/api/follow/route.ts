/**
 * 关注/取消关注交易员 API
 * GET /api/follow?traderId=xxx - 检查是否关注
 * POST /api/follow - 关注/取消关注
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withApiMiddleware, createErrorResponse } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { createLogger } from '@/lib/utils/logger'
import { invalidateFollowingCache } from '@/app/api/following/route'

const logger = createLogger('follow-api')

// Zod schema for POST /api/follow
const FollowActionSchema = z.object({
  traderId: z.string().min(1, 'traderId is required'),
  action: z.enum(['follow', 'unfollow'], { message: 'action must be follow or unfollow' }),
})

export const dynamic = 'force-dynamic'

/**
 * GET /api/follow?traderId=xxx
 * 检查当前用户是否关注指定交易员
 */
export const GET = withApiMiddleware(
  async ({ user, supabase, request }) => {
    // 需要认证
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    const traderId = request.nextUrl.searchParams.get('traderId')

    if (!traderId) {
      return createErrorResponse('Missing traderId parameter', 400)
    }

    const { data, error } = await supabase
      .from('trader_follows')
      .select('id')
      .eq('user_id', user.id)
      .eq('trader_id', traderId)
      .maybeSingle()

    if (error) {
      // 如果表不存在，返回未关注状态
      if (error.message?.includes('Could not find the table')) {
        logger.warn('trader_follows 表不存在')
        return NextResponse.json({ following: false, tableNotFound: true })
      }
      logger.error('查询关注状态失败', { error, traderId, userId: user.id })
      return createErrorResponse('Query failed', 500)
    }

    return { following: !!data }
  },
  {
    name: 'follow-check',
    requireAuth: true,
    rateLimit: 'read', // 500次/分钟，读取操作
  }
)

/**
 * POST /api/follow
 * 关注或取消关注交易员
 * Body: { traderId: string, action: 'follow' | 'unfollow' }
 */
export const POST = withApiMiddleware(
  async ({ user, supabase, request }) => {
    // 需要认证
    if (!user) {
      return createErrorResponse('Unauthorized', 401)
    }

    const body = await request.json()
    const parsed = FollowActionSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }
    const { traderId, action } = parsed.data

    if (action === 'follow') {
      // 关注
      const { error } = await supabase
        .from('trader_follows')
        .insert({ user_id: user.id, trader_id: traderId })

      if (error) {
        // 如果是重复关注，忽略错误
        if (error.code === '23505') {
          return { success: true, following: true }
        }
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          logger.warn('trader_follows 表不存在')
          return createErrorResponse('Follow feature not available yet', 503)
        }
        logger.error('Follow failed', { error, traderId, userId: user.id })
        return createErrorResponse('Follow failed', 500)
      }

      logger.info('用户关注交易员', { userId: user.id, traderId })
      await invalidateFollowingCache(user.id).catch(() => {})
      return { success: true, following: true }
    } else {
      // 取消关注
      const { error } = await supabase
        .from('trader_follows')
        .delete()
        .eq('user_id', user.id)
        .eq('trader_id', traderId)

      if (error) {
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          logger.warn('trader_follows 表不存在')
          return createErrorResponse('Follow feature not available yet', 503)
        }
        logger.error('Unfollow failed', { error, traderId, userId: user.id })
        return createErrorResponse('Unfollow failed', 500)
      }

      logger.info('用户取消关注交易员', { userId: user.id, traderId })
      await invalidateFollowingCache(user.id).catch(() => {})
      return { success: true, following: false }
    }
  },
  {
    name: 'follow-action',
    skipCsrf: true,
    requireAuth: true,
    rateLimit: 'write', // 50次/分钟
  }
)
