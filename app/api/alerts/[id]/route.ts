/**
 * 单个告警 API
 * PUT /api/alerts/[id] - 标记告警为已读
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
import { markAlertRead } from '@/lib/data/alerts'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * PUT /api/alerts/[id]
 * 标记告警为已读
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const { id } = await params

    if (!id) {
      return handleError(new Error('缺少告警 ID'), 'alert PUT')
    }

    await markAlertRead(supabase, id, user.id)

    return success({ message: '已标记为已读' })
  } catch (error) {
    return handleError(error, 'alert PUT')
  }
}
