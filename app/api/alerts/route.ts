/**
 * V1 legacy trader-alert history inventory.
 *
 * Monitoring and delivery are not published. This owner-scoped endpoint exists
 * only to inspect legacy records; it must never imply active alert service.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, requireAuth, handleError } from '@/lib/api'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import logger from '@/lib/logger'
import {
  TRADER_ALERTS_NOT_PUBLISHED_CODE,
  TRADER_ALERTS_NO_STORE_HEADERS,
  TRADER_ALERTS_PUBLISHED,
} from '@/lib/alerts/trader-alert-publication'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

/** GET — list an authenticated owner's legacy alert history. */
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
      return NextResponse.json(
        { success: false, error: 'Failed to fetch alert history' },
        { status: 500, headers: TRADER_ALERTS_NO_STORE_HEADERS }
      )
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          available: TRADER_ALERTS_PUBLISHED,
          code: TRADER_ALERTS_NOT_PUBLISHED_CODE,
          history: history || [],
          total: count || 0,
        },
      },
      { headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  } catch (err: unknown) {
    const response = handleError(err)
    for (const [key, value] of Object.entries(TRADER_ALERTS_NO_STORE_HEADERS)) {
      response.headers.set(key, value)
    }
    return response
  }
}
