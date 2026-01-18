/**
 * 日记点赞 API
 * POST /api/journals/[id]/like - 点赞
 * DELETE /api/journals/[id]/like - 取消点赞
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { likeJournal, unlikeJournal } from '@/lib/data/follow-journals'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * POST /api/journals/[id]/like
 * 点赞日记
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少日记 ID'), 'journal like POST')
    }

    await likeJournal(supabase, id, user.id)

    return success({ message: '点赞成功' })
  } catch (error) {
    return handleError(error, 'journal like POST')
  }
}

/**
 * DELETE /api/journals/[id]/like
 * 取消点赞
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少日记 ID'), 'journal like DELETE')
    }

    await unlikeJournal(supabase, id, user.id)

    return success({ message: '已取消点赞' })
  } catch (error) {
    return handleError(error, 'journal like DELETE')
  }
}
