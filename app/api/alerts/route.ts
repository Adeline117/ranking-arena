/**
 * 提醒历史 API
 *
 * GET /api/alerts - 获取提醒触发历史
 * GET /api/alerts?alert_id=xxx - 获取指定提醒的历史
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
} from '@/lib/api'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const preferredRegion = ['sfo1', 'hnd1']

/**
 * GET - 获取提醒触发历史
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { searchParams } = new URL(request.url)
    const alertId = searchParams.get('alert_id')
    const limit = parseLimit(searchParams.get('limit'), 50, 100)
    const offset = parseOffset(searchParams.get('offset'))

    // KEEP 'exact' — per-user alert history pagination. Scoped via
    // eq(user_id) to a single user's small row set, cheap via (user_id,
    // triggered_at DESC) index.
    let query = supabase
      .from('alert_history')
      .select('*', { count: 'exact' })
      .eq('user_id', user.id)
      .order('triggered_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (alertId) {
      query = query.eq('alert_id', alertId)
    }

    const { data: history, error: queryError, count } = await query

    if (queryError) {
      logger.error('[alerts] 查询历史Failed:', queryError)
      return error('Failed to fetch alert history', 500)
    }

    return success({ history: history || [], total: count || 0 })
  } catch (err: unknown) {
    return handleError(err)
  }
}
