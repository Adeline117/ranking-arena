/**
 * 关注/取消关注交易员 API
 * GET /api/follow?traderId=xxx - 检查是否关注
 * POST /api/follow - 关注/取消关注
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { ApiError } from '@/lib/api/errors'
import { badRequest, serverError } from '@/lib/api/response'
import { createLogger, fireAndForget } from '@/lib/utils/logger'
import { getFeatureLimits, PRO_FREE_PROMO } from '@/lib/types/premium'
import { sendNotification } from '@/lib/data/notifications'
import { invalidateFollowingCache } from '@/app/api/following/route'

const logger = createLogger('follow-api')

const controlCharacterPattern = /[\u0000-\u001f\u007f]/
const TraderIdSchema = z
  .string()
  .trim()
  .min(1, 'traderId is required')
  .max(255)
  .refine((value) => !controlCharacterPattern.test(value), 'traderId contains control characters')
const TraderSourceSchema = z
  .string()
  .trim()
  .min(1, 'source is required')
  .max(64)
  .refine((value) => !controlCharacterPattern.test(value), 'source contains control characters')

// A trader account is identified by (source, traderId), never by traderId
// alone. The only nullable source accepted is an explicit legacy unfollow:
// pre-composite rows are surfaced by /api/following with source=null so users
// can remove them precisely instead of leaving an invisible/undeletable edge.
const FollowActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      traderId: TraderIdSchema,
      source: TraderSourceSchema,
      action: z.literal('follow'),
    })
    .strict(),
  z
    .object({
      traderId: TraderIdSchema,
      source: TraderSourceSchema.nullable(),
      action: z.literal('unfollow'),
    })
    .strict(),
])

export const dynamic = 'force-dynamic'

const FREE_FOLLOW_LIMIT = getFeatureLimits('free').followLimit
const PRO_FOLLOW_LIMIT = getFeatureLimits('pro').followLimit

type FollowMutationAck =
  | { status: 'invalid' | 'account_inactive' }
  | {
      status: 'unfollowed' | 'not_following'
      userId: string
      traderId: string
      source: string | null
      following: false
    }
  | {
      status: 'followed' | 'already_following' | 'limit_reached'
      userId: string
      traderId: string
      source: string
      following: boolean
      currentCount: number
      limit: number
    }

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key)
}

function parseMutationAck(value: unknown): FollowMutationAck | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const result = value as Record<string, unknown>

  if (
    exactKeys(result, ['status']) &&
    (result.status === 'invalid' || result.status === 'account_inactive')
  ) {
    return { status: result.status }
  }

  if (
    exactKeys(result, ['following', 'source', 'status', 'trader_id', 'user_id']) &&
    (result.status === 'unfollowed' || result.status === 'not_following') &&
    result.following === false &&
    typeof result.user_id === 'string' &&
    result.user_id.length > 0 &&
    typeof result.trader_id === 'string' &&
    result.trader_id.length > 0 &&
    (result.source === null || (typeof result.source === 'string' && result.source.length > 0))
  ) {
    return {
      status: result.status,
      userId: result.user_id,
      traderId: result.trader_id,
      source: result.source,
      following: false,
    }
  }

  if (
    !exactKeys(result, [
      'current_count',
      'following',
      'limit',
      'source',
      'status',
      'trader_id',
      'user_id',
    ]) ||
    !['followed', 'already_following', 'limit_reached'].includes(String(result.status)) ||
    typeof result.user_id !== 'string' ||
    !result.user_id ||
    typeof result.trader_id !== 'string' ||
    !result.trader_id ||
    typeof result.source !== 'string' ||
    !result.source ||
    typeof result.following !== 'boolean' ||
    !Number.isSafeInteger(result.current_count) ||
    Number(result.current_count) < 0 ||
    !Number.isSafeInteger(result.limit) ||
    Number(result.limit) < 1 ||
    (result.status === 'limit_reached' &&
      (result.following !== false || Number(result.current_count) < Number(result.limit))) ||
    ((result.status === 'followed' || result.status === 'already_following') &&
      result.following !== true) ||
    (result.status === 'followed' && Number(result.current_count) > Number(result.limit))
  ) {
    return null
  }

  return {
    status: result.status as 'followed' | 'already_following' | 'limit_reached',
    userId: result.user_id,
    traderId: result.trader_id,
    source: result.source,
    following: result.following,
    currentCount: Number(result.current_count),
    limit: Number(result.limit),
  }
}

/**
 * GET /api/follow?traderId=xxx
 * 检查当前用户是否关注指定交易员
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const parsedTraderId = TraderIdSchema.safeParse(request.nextUrl.searchParams.get('traderId'))
    const parsedSource = TraderSourceSchema.safeParse(request.nextUrl.searchParams.get('source'))

    if (!parsedTraderId.success) {
      return badRequest('Missing traderId parameter')
    }
    if (!parsedSource.success) {
      return badRequest('Missing source parameter')
    }
    const traderId = parsedTraderId.data
    const source = parsedSource.data

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
        return { following: false, traderId, source, tableNotFound: true as const }
      }
      logger.error('查询关注状态失败', { error, traderId, userId: user.id })
      return serverError('Query failed')
    }

    return { following: !!data, traderId, source }
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
    let body: unknown
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

    const { data: rawAck, error: mutationError } = await supabase.rpc(
      'mutate_trader_follow_atomic',
      {
        p_actor_id: user.id,
        p_trader_id: traderId,
        p_source: source,
        p_action: action,
        p_promo_unlocked: PRO_FREE_PROMO,
        p_free_limit: FREE_FOLLOW_LIMIT,
        p_pro_limit: PRO_FOLLOW_LIMIT,
      }
    )
    const ack = parseMutationAck(rawAck)
    if (
      mutationError ||
      !ack ||
      ('userId' in ack &&
        (ack.userId !== user.id || ack.traderId !== traderId || ack.source !== source))
    ) {
      logger.error('Atomic trader follow mutation failed', {
        action,
        traderId,
        source,
        userId: user.id,
        code: mutationError?.code,
      })
      return serverError('Follow mutation failed')
    }
    if (
      'userId' in ack &&
      ((action === 'follow' &&
        ack.status !== 'followed' &&
        ack.status !== 'already_following' &&
        ack.status !== 'limit_reached') ||
        (action === 'unfollow' && ack.status !== 'unfollowed' && ack.status !== 'not_following'))
    ) {
      logger.error('Atomic trader follow mutation returned the wrong action', {
        action,
        status: ack.status,
        traderId,
        source,
        userId: user.id,
      })
      return serverError('Follow mutation failed')
    }
    if (ack.status === 'invalid') {
      logger.error('Atomic trader follow policy was rejected', {
        action,
        traderId,
        source,
        userId: user.id,
      })
      return serverError('Follow mutation failed')
    }
    if (ack.status === 'account_inactive') {
      return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
    }
    if (ack.status === 'limit_reached') {
      return NextResponse.json(
        {
          error: `Follow limit reached (${ack.limit}). Upgrade to Pro for more.`,
          code: 'FOLLOW_LIMIT',
        },
        { status: 429 }
      )
    }

    if (action === 'follow') {
      if (ack.status === 'already_following') {
        return { following: true, traderId, source }
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

      return { following: true, traderId, source }
    } else {
      if (ack.status === 'not_following') {
        return { following: false, traderId, source }
      }

      logger.info('用户取消关注交易员', { userId: user.id, traderId, source })
      fireAndForget(invalidateFollowingCache(user.id), 'invalidate-following-cache')
      return { following: false, traderId, source }
    }
  },
  {
    name: 'follow-action',
    rateLimit: 'write',
  }
)
