/**
 * 交易员评价 API
 * GET  /api/trader/[handle]/reviews - 获取评价列表 + 摘要
 * POST /api/trader/[handle]/reviews - 添加评价
 * DELETE /api/trader/[handle]/reviews - 删除评价
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
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
  getTraderReviews,
  getReviewSummary,
  createReview,
  deleteReview,
} from '@/lib/data/reviews'

type RouteContext = { params: Promise<{ handle: string }> }

/**
 * 根据 handle 查找 trader ID
 */
async function resolveTraderIdByHandle(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  handle: string,
): Promise<string | null> {
  // 先尝试从 user_profiles 查找（已注册交易员）
  const { data: userProfile } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('handle', handle)
    .maybeSingle()

  if (userProfile) return userProfile.id

  // 再从 trader_sources 查找（未注册但有 scrape 数据的）
  const { data: traderSource } = await supabase
    .from('trader_sources')
    .select('id')
    .eq('handle', handle)
    .maybeSingle()

  return traderSource?.id ?? null
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { handle: rawHandle } = await context.params
    const handle = decodeURIComponent(rawHandle)
    const { searchParams } = new URL(request.url)

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 50 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const sort = (searchParams.get('sort') === 'top' ? 'top' : 'newest') as 'newest' | 'top'

    const supabase = getSupabaseAdmin()

    const traderId = await resolveTraderIdByHandle(supabase, handle)
    if (!traderId) {
      return success({ reviews: [], summary: { avg_rating: 0, review_count: 0, rating_distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } })
    }

    // 尝试获取当前用户 ID（用于点赞状态）
    let userId: string | undefined
    const authHeader = request.headers.get('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data: { user } } = await supabase.auth.getUser(token)
      userId = user?.id
    }

    const [reviews, summary] = await Promise.all([
      getTraderReviews(supabase, traderId, { limit, offset, userId, sort }),
      getReviewSummary(supabase, traderId),
    ])

    return successWithPagination(
      { reviews, summary },
      { limit, offset, has_more: reviews.length === limit }
    )
  } catch (error: unknown) {
    return handleError(error, 'trader/[handle]/reviews GET')
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const { handle: rawHandle } = await context.params
    const handle = decodeURIComponent(rawHandle)
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const traderId = await resolveTraderIdByHandle(supabase, handle)
    if (!traderId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Trader not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // 不能给自己评价
    if (traderId === user.id) {
      return new Response(
        JSON.stringify({ success: false, error: 'Cannot review yourself' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const body = await request.json()
    const rating = validateNumber(body.rating, { min: 1, max: 5 })
    if (!rating) {
      return new Response(
        JSON.stringify({ success: false, error: 'Rating must be between 1 and 5' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const content = validateString(body.content, {
      required: true,
      minLength: 1,
      maxLength: 2000,
      fieldName: 'review content',
    })!

    const review = await createReview(supabase, user.id, {
      trader_id: traderId,
      rating,
      content,
    })

    return success({ review }, 201)
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'ALREADY_REVIEWED') {
      return new Response(
        JSON.stringify({ success: false, error: 'You have already reviewed this trader' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return handleError(error, 'trader/[handle]/reviews POST')
  }
}

export async function DELETE(request: NextRequest, _context: RouteContext) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const reviewId = validateString(body.review_id, {
      required: true,
      fieldName: 'review ID',
    })!

    await deleteReview(supabase, reviewId, user.id)

    return success({ message: 'Review deleted' })
  } catch (error: unknown) {
    return handleError(error, 'trader/[handle]/reviews DELETE')
  }
}
