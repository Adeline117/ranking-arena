/**
 * 评价投票 API
 * POST /api/reviews/[id]/vote - 投票（有帮助/无帮助）
 * DELETE /api/reviews/[id]/vote - 取消投票
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { voteReview, removeVote } from '@/lib/data/reviews'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/reviews/[id]/vote
 * 投票
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params
    const body = await request.json()

    if (!id) {
      return handleError(new Error('缺少评价 ID'), 'vote POST')
    }

    const vote_type = validateEnum(body.vote_type, ['helpful', 'unhelpful'] as const)
    if (!vote_type) {
      return handleError(new Error('vote_type 必须是 helpful 或 unhelpful'), 'vote POST')
    }

    await voteReview(supabase, id, user.id, vote_type)

    return success({ message: '投票成功' })
  } catch (error) {
    return handleError(error, 'vote POST')
  }
}

/**
 * DELETE /api/reviews/[id]/vote
 * 取消投票
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少评价 ID'), 'vote DELETE')
    }

    await removeVote(supabase, id, user.id)

    return success({ message: '已取消投票' })
  } catch (error) {
    return handleError(error, 'vote DELETE')
  }
}
