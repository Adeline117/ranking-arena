/**
 * 避雷榜 API
 * GET /api/avoid-list - 获取避雷榜
 * POST /api/avoid-list - 创建避雷投票
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import {
  getAvoidList,
  getTraderAvoidScore,
  getTraderAvoidVotes,
  getUserAvoidVote,
  createAvoidVote,
  hasUserVoted,
  type AvoidReasonType,
} from '@/lib/data/avoid-list'

/**
 * GET /api/avoid-list
 * 获取避雷榜或特定交易员的避雷信息
 */
export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const trader_id = validateString(searchParams.get('trader_id'))
    const source = validateString(searchParams.get('source'))
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    // 获取当前用户（可选）
    const user = await getAuthUser(request)

    if (trader_id && source) {
      // 获取特定交易员的避雷信息
      const [avoidScore, votes, userVote] = await Promise.all([
        getTraderAvoidScore(supabase, trader_id, source),
        getTraderAvoidVotes(supabase, trader_id, source, { limit, offset }),
        user ? getUserAvoidVote(supabase, user.id, trader_id, source) : null,
      ])

      return successWithPagination(
        {
          avoid_score: avoidScore,
          votes,
          user_vote: userVote,
        },
        { limit, offset, has_more: votes.length === limit }
      )
    } else {
      // 获取避雷榜
      const avoidList = await getAvoidList(supabase, { limit, offset })

      return successWithPagination(
        { avoid_list: avoidList },
        { limit, offset, has_more: avoidList.length === limit }
      )
    }
  } catch (error: unknown) {
    return handleError(error, 'avoid-list GET')
  }
}

/**
 * POST /api/avoid-list
 * 创建避雷投票
 */
export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    const trader_id = validateString(body.trader_id, { required: true, fieldName: 'trader_id' })
    const source = validateString(body.source, { required: true, fieldName: 'source' })

    if (!trader_id || !source) {
      return handleError(new Error('缺少必填参数'), 'avoid-list POST')
    }

    // 检查是否已投票
    const alreadyVoted = await hasUserVoted(supabase, user.id, trader_id, source)
    if (alreadyVoted) {
      return handleError(new Error('您已经对该交易员投过避雷票'), 'avoid-list POST')
    }

    const reason = validateString(body.reason, { maxLength: 1000 })
    const reason_type = validateEnum(
      body.reason_type,
      ['high_drawdown', 'fake_data', 'inconsistent', 'poor_communication', 'other'] as const
    )
    const loss_amount = validateNumber(body.loss_amount, { min: 0 })
    const loss_percent = validateNumber(body.loss_percent)
    const follow_duration_days = validateNumber(body.follow_duration_days, { min: 0 })
    const screenshot_url = validateString(body.screenshot_url, { maxLength: 500 })

    const vote = await createAvoidVote(supabase, user.id, {
      trader_id,
      source,
      reason: reason ?? undefined,
      reason_type: reason_type as AvoidReasonType | undefined,
      loss_amount: loss_amount ?? undefined,
      loss_percent: loss_percent ?? undefined,
      follow_duration_days: follow_duration_days ?? undefined,
      screenshot_url: screenshot_url ?? undefined,
    })

    return success({ vote, message: '避雷投票已提交' })
  } catch (error: unknown) {
    return handleError(error, 'avoid-list POST')
  }
}
