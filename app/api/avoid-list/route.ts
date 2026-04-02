/**
 * 避雷榜 API
 * GET /api/avoid-list - 获取避雷榜
 * POST /api/avoid-list - 创建避雷投票
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
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

// Zod schema for POST /api/avoid-list
const AvoidVoteSchema = z.object({
  trader_id: z.string().min(1, 'trader_id is required'),
  source: z.string().min(1, 'source is required'),
  reason: z.string().max(1000).optional().nullable(),
  reason_type: z.enum(['high_drawdown', 'fake_data', 'inconsistent', 'poor_communication', 'other']).optional().nullable(),
  loss_amount: z.number().min(0).optional().nullable(),
  loss_percent: z.number().optional().nullable(),
  follow_duration_days: z.number().min(0).optional().nullable(),
  screenshot_url: z.string().url().max(500).optional().nullable(),
})

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

      const response = successWithPagination(
        {
          avoid_score: avoidScore,
          votes,
          user_vote: userVote,
        },
        { limit, offset, has_more: votes.length === limit }
      )
      response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
      return response
    } else {
      // 获取避雷榜
      const avoidList = await getAvoidList(supabase, { limit, offset })

      const response = successWithPagination(
        { avoid_list: avoidList },
        { limit, offset, has_more: avoidList.length === limit }
      )
      response.headers.set('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300')
      return response
    }
  } catch (error: unknown) {
    // Gracefully handle missing table (feature not yet deployed)
    const msg = error instanceof Error ? error.message : String(error)
    if (
      msg.includes('trader_avoid_scores') ||
      msg.includes('trader_avoid_votes') ||
      msg.includes('avoid_votes') ||
      msg.includes('does not exist') ||
      msg.includes('42P01')
    ) {
      return success({ avoid_list: [], message: 'Feature coming soon' })
    }
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

    const parsed = AvoidVoteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { trader_id, source } = parsed.data

    // 检查是否已投票
    const alreadyVoted = await hasUserVoted(supabase, user.id, trader_id, source)
    if (alreadyVoted) {
      return handleError(new Error('You have already voted to avoid this trader'), 'avoid-list POST')
    }

    const vote = await createAvoidVote(supabase, user.id, {
      trader_id,
      source,
      reason: parsed.data.reason ?? undefined,
      reason_type: (parsed.data.reason_type as AvoidReasonType) ?? undefined,
      loss_amount: parsed.data.loss_amount ?? undefined,
      loss_percent: parsed.data.loss_percent ?? undefined,
      follow_duration_days: parsed.data.follow_duration_days ?? undefined,
      screenshot_url: parsed.data.screenshot_url ?? undefined,
    })

    return success({ vote, message: 'Avoid list vote submitted' })
  } catch (error: unknown) {
    return handleError(error, 'avoid-list POST')
  }
}
