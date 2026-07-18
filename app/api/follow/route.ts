/**
 * 关注/取消关注交易员 API
 * GET /api/follow?traderId=xxx - 检查是否关注
 * POST /api/follow - 关注/取消关注
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { success, badRequest, serverError } from '@/lib/api/response'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { sendNotification } from '@/lib/data/notifications'
import { invalidateFollowingCache } from '@/app/api/following/route'

const logger = createLogger('follow-api')

const TraderIdSchema = z.string().trim().min(1, 'traderId is required')
const TraderSourceSchema = z.string().trim().min(1, 'source is required').max(64)

// A trader account is identified by (source, traderId), never by traderId
// alone. The only nullable source accepted is an explicit legacy unfollow:
// pre-composite rows are surfaced by /api/following with source=null so users
// can remove them precisely instead of leaving an invisible/undeletable edge.
const FollowActionSchema = z.discriminatedUnion('action', [
  z.object({
    traderId: TraderIdSchema,
    source: TraderSourceSchema,
    action: z.literal('follow'),
  }),
  z.object({
    traderId: TraderIdSchema,
    source: TraderSourceSchema.nullable(),
    action: z.literal('unfollow'),
  }),
])

export const dynamic = 'force-dynamic'

/**
 * GET /api/follow?traderId=xxx
 * 检查当前用户是否关注指定交易员
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const traderId = request.nextUrl.searchParams.get('traderId')
    const source = request.nextUrl.searchParams.get('source')

    if (!traderId) {
      return badRequest('Missing traderId parameter')
    }
    if (!source) {
      return badRequest('Missing source parameter')
    }

    const query = supabase
      .from('trader_follows')
      .select('id')
      .eq('user_id', user.id)
      .eq('trader_id', traderId)
      .eq('source', source)
    const { data, error } = await query.maybeSingle()

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
    const { traderId, source, action } = parsed.data

    if (action === 'follow') {
      // Enforce follow limit per tier (free=10, pro=100)
      const [{ count: followCount }, { data: sub }] = await Promise.all([
        supabase
          .from('trader_follows')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id),
        supabase
          .from('subscriptions')
          .select('tier')
          .eq('user_id', user.id)
          .in('status', ['active', 'trialing'])
          .maybeSingle(),
      ])
      const tier = sub?.tier || 'free'
      const limit = PRO_FREE_PROMO || tier === 'pro' || tier === 'elite' ? 100 : 10
      if ((followCount ?? 0) >= limit) {
        return NextResponse.json(
          {
            error: `Follow limit reached (${limit}). Upgrade to Pro for more.`,
            code: 'FOLLOW_LIMIT',
          },
          { status: 429 }
        )
      }

      // 关注
      const { error } = await supabase
        .from('trader_follows')
        .insert({ user_id: user.id, trader_id: traderId, source })

      if (error) {
        // 如果是重复关注，忽略错误
        if (error.code === '23505') {
          return { following: true }
        }
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          logger.warn('trader_follows 表不存在')
          throw new ApiError('Follow feature not available yet', {
            code: ErrorCode.SERVICE_UNAVAILABLE,
            statusCode: 503,
          })
        }
        logger.error('Follow failed', { error, traderId, userId: user.id })
        return serverError('Follow failed')
      }

      logger.info('用户关注交易员', { userId: user.id, traderId, source })
      fireAndForget(invalidateFollowingCache(user.id), 'invalidate-following-cache')

      // Fire-and-forget: notify the followed trader's claimed user (if any)
      fireAndForget(
        (async () => {
          const { data: claim } = await supabase
            .from('verified_traders')
            .select('user_id')
            .eq('trader_id', traderId)
            .eq('source', source)
            .maybeSingle()
          if (claim?.user_id && claim.user_id !== user.id) {
            sendNotification(
              supabase,
              {
                user_id: claim.user_id,
                type: 'new_follower',
                title: 'New Follower',
                message: 'Someone started following your trader profile',
                link: `/trader/${encodeURIComponent(traderId)}?platform=${encodeURIComponent(source)}`,
                actor_id: user.id,
                reference_id: `${source}:${traderId}`,
              },
              'Trader follow notification'
            )
          }
        })(),
        'Trader follow notification lookup'
      )

      return { following: true }
    } else {
      // 取消关注
      let deleteQuery = supabase
        .from('trader_follows')
        .delete()
        .eq('user_id', user.id)
        .eq('trader_id', traderId)
      deleteQuery =
        source === null ? deleteQuery.is('source', null) : deleteQuery.eq('source', source)
      const { error } = await deleteQuery

      if (error) {
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          logger.warn('trader_follows 表不存在')
          throw new ApiError('Follow feature not available yet', {
            code: ErrorCode.SERVICE_UNAVAILABLE,
            statusCode: 503,
          })
        }
        logger.error('Unfollow failed', { error, traderId, userId: user.id })
        return serverError('Unfollow failed')
      }

      logger.info('用户取消关注交易员', { userId: user.id, traderId, source })
      fireAndForget(invalidateFollowingCache(user.id), 'invalidate-following-cache')
      return { following: false }
    }
  },
  {
    name: 'follow-action',
    rateLimit: 'write',
  }
)
