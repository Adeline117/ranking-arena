/**
 * 单个评价 API
 * PUT /api/reviews/[id] - 更新评价
 * DELETE /api/reviews/[id] - 删除评价
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateString,
  validateNumber,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { updateReview, deleteReview } from '@/lib/data/reviews'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * PUT /api/reviews/[id]
 * 更新评价
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params
    const body = await request.json()

    if (!id) {
      return handleError(new Error('缺少评价 ID'), 'reviews PUT')
    }

    const overall_rating = validateNumber(body.overall_rating, { min: 1, max: 5 })
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

    const review = await updateReview(supabase, id, user.id, {
      overall_rating: overall_rating ?? undefined,
      stability_rating: stability_rating ?? undefined,
      drawdown_rating: drawdown_rating ?? undefined,
      review_text: review_text ?? undefined,
      follow_duration_days: follow_duration_days ?? undefined,
      profit_loss_percent,
      would_recommend,
      screenshot_url: screenshot_url ?? undefined,
    })

    return success({ review, message: '评价更新成功' })
  } catch (error) {
    return handleError(error, 'reviews PUT')
  }
}

/**
 * DELETE /api/reviews/[id]
 * 删除评价
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少评价 ID'), 'reviews DELETE')
    }

    await deleteReview(supabase, id, user.id)

    return success({ message: '评价已删除' })
  } catch (error) {
    return handleError(error, 'reviews DELETE')
  }
}
