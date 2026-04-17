/**
 * 关注/取消关注交易员 API
 * GET /api/follow?traderId=xxx - 检查是否关注
 * POST /api/follow - 关注/取消关注
 */

import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success, badRequest, serverError } from '@/lib/api/response'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
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
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const traderId = request.nextUrl.searchParams.get('traderId')

    if (!traderId) {
      return badRequest('Missing traderId parameter')
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
        return success({ following: false, tableNotFound: true })
      }
      logger.error('查询关注状态失败', { error, traderId, userId: user.id })
      return serverError('Query failed')
    }

    return { following: !!data }
  },
  {
    name: 'follow-check',
    rateLimit: 'read',
  }
)

/**
 * POST /api/follow
 * 关注或取消关注交易员
 * Body: { traderId: string, action: 'follow' | 'unfollow' }
 */
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
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
          return { following: true }
        }
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          logger.warn('trader_follows 表不存在')
          throw new ApiError('Follow feature not available yet', { code: ErrorCode.SERVICE_UNAVAILABLE, statusCode: 503 })
        }
        logger.error('Follow failed', { error, traderId, userId: user.id })
        return serverError('Follow failed')
      }

      logger.info('用户关注交易员', { userId: user.id, traderId })
      fireAndForget(invalidateFollowingCache(user.id), 'invalidate-following-cache')

      // Fire-and-forget: notify the followed trader's claimed user (if any)
      ;(async () => {
        try {
          const { data: claim } = await supabase
            .from('verified_traders')
            .select('user_id')
            .eq('trader_id', traderId)
            .maybeSingle()
          if (claim?.user_id && claim.user_id !== user.id) {
            const { error: notifError } = await supabase.from('notifications').insert({
              user_id: claim.user_id,
              type: 'new_follower',
              title: 'New Follower',
              message: 'Someone started following your trader profile',
              link: `/trader/${encodeURIComponent(traderId)}`,
              actor_id: user.id,
              reference_id: traderId,
            })
            if (notifError) {
              logger.error('Failed to insert follow notification', { error: notifError, traderId, claimUserId: claim.user_id })
            }
          }
        } catch (err) {
          logger.error('Follow notification fire-and-forget failed', { error: err, traderId, userId: user.id })
        }
      })()

      return { following: true }
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
          throw new ApiError('Follow feature not available yet', { code: ErrorCode.SERVICE_UNAVAILABLE, statusCode: 503 })
        }
        logger.error('Unfollow failed', { error, traderId, userId: user.id })
        return serverError('Unfollow failed')
      }

      logger.info('用户取消关注交易员', { userId: user.id, traderId })
      fireAndForget(invalidateFollowingCache(user.id), 'invalidate-following-cache')
      return { following: false }
    }
  },
  {
    name: 'follow-action',
    rateLimit: 'write',
  }
)
