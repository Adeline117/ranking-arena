/**
 * 交易员评价 API
 * GET /api/reviews - 获取交易员评价列表
 * POST /api/reviews - 创建评价
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
  getTraderReviews,
  getTraderCommunityScore,
  getUserReview,
  createReview,
  type ReviewListOptions,
} from '@/lib/data/reviews'

/**
 * GET /api/reviews
 * 获取交易员评价列表
 */
export async function GET(request: NextRequest) {
  // 公开 API 限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)

    const trader_id = validateString(searchParams.get('trader_id'), {
      required: true,
      fieldName: 'trader_id',
    })
    const source = validateString(searchParams.get('source'), {
      required: true,
      fieldName: 'source',
    })

    if (!trader_id || !source) {
      return handleError(new Error('缺少 trader_id 或 source 参数'), 'reviews GET')
    }

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const sort_by = validateEnum(
      searchParams.get('sort_by'),
      ['created_at', 'helpful_count', 'overall_rating'] as const
    ) ?? 'created_at'
    const sort_order = validateEnum(
      searchParams.get('sort_order'),
      ['asc', 'desc'] as const
    ) ?? 'desc'
    const verified_only = searchParams.get('verified_only') === 'true'

    // 获取当前用户（可选）
    const user = await getAuthUser(request)

    const options: ReviewListOptions = {
      limit,
      offset,
      sort_by,
      sort_order,
      verified_only,
    }

    // 并行获取评价列表和社区评分
    const [reviews, communityScore] = await Promise.all([
      getTraderReviews(supabase, trader_id, source, options, user?.id),
      getTraderCommunityScore(supabase, trader_id, source),
    ])

    // 检查当前用户是否已评价
    let userReview = null
    if (user) {
      userReview = await getUserReview(supabase, user.id, trader_id, source)
    }

    return successWithPagination(
      {
        reviews,
        community_score: communityScore,
        user_review: userReview,
      },
      {
        limit,
        offset,
        has_more: reviews.length === limit,
      }
    )
  } catch (error) {
    return handleError(error, 'reviews GET')
  }
}

/**
 * POST /api/reviews
 * 创建评价
 */
export async function POST(request: NextRequest) {
  // 敏感操作限流：每分钟 10 次
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    // 验证必填字段
    const trader_id = validateString(body.trader_id, {
      required: true,
      fieldName: 'trader_id',
    })
    const source = validateString(body.source, {
      required: true,
      fieldName: 'source',
    })
    const overall_rating = validateNumber(body.overall_rating, {
      min: 1,
      max: 5,
      required: true,
    })

    if (!trader_id || !source || overall_rating === null) {
      return handleError(new Error('缺少必填参数'), 'reviews POST')
    }

    // 检查是否已评价
    const existingReview = await getUserReview(supabase, user.id, trader_id, source)
    if (existingReview) {
      return handleError(new Error('您已经评价过该交易员'), 'reviews POST')
    }

    // 可选字段
    const stability_rating = validateNumber(body.stability_rating, { min: 1, max: 5 })
    const drawdown_rating = validateNumber(body.drawdown_rating, { min: 1, max: 5 })
    const review_text = validateString(body.review_text, { maxLength: 2000 })
    const follow_duration_days = validateNumber(body.follow_duration_days, { min: 0 })
    const profit_loss_percent = body.profit_loss_percent !== undefined 
      ? Number(body.profit_loss_percent) 
      : undefined
    const would_recommend = typeof body.would_recommend === 'boolean' 
      ? body.would_recommend 
      : undefined
    const screenshot_url = validateString(body.screenshot_url, { maxLength: 500 })

    const review = await createReview(supabase, user.id, {
      trader_id,
      source,
      overall_rating,
      stability_rating: stability_rating ?? undefined,
      drawdown_rating: drawdown_rating ?? undefined,
      review_text: review_text ?? undefined,
      follow_duration_days: follow_duration_days ?? undefined,
      profit_loss_percent,
      would_recommend,
      screenshot_url: screenshot_url ?? undefined,
    })

    return success({ review, message: '评价创建成功' })
  } catch (error) {
    return handleError(error, 'reviews POST')
  }
}
