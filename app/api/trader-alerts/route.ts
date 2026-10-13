/**
 * V1 legacy trader-alert inventory and cleanup API.
 *
 * Monitoring, delivery, and new configuration publication are paused. Owners
 * may only list or delete their own persisted legacy rows.
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import {
  TRADER_ALERTS_NOT_PUBLISHED_CODE,
  TRADER_ALERTS_NO_STORE_HEADERS,
  TRADER_ALERTS_PUBLISHED,
  TRADER_ALERTS_UNAVAILABLE_MESSAGE,
} from '@/lib/alerts/trader-alert-publication'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const logger = createLogger('trader-alerts')

/** GET — list the authenticated owner's legacy configurations for cleanup. */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    // Legacy inventory remains readable to its owner so a lapsed subscriber can
    // remove a configuration that V1 no longer monitors.
    const { searchParams } = new URL(request.url)
    const traderId = searchParams.get('trader_id')
    const source = searchParams.get('source')

    let query = supabase
      .from('trader_alerts')
      .select(
        'id, trader_id, source, alert_roi_change, roi_change_threshold, alert_drawdown, drawdown_threshold, alert_pnl_change, pnl_change_threshold, alert_score_change, score_change_threshold, alert_rank_change, rank_change_threshold, one_time, enabled, created_at'
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (traderId) {
      query = query.eq('trader_id', traderId)
      if (source) query = query.eq('source', source)
    }

    const { data: alerts, error: queryError } = await query

    if (queryError) {
      logger.error('[trader-alerts] 查询Failed:', queryError)
      throw new Error('Failed to fetch alert config')
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          available: TRADER_ALERTS_PUBLISHED,
          code: TRADER_ALERTS_NOT_PUBLISHED_CODE,
          alerts: alerts || [],
        },
      },
      { headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  },
  { name: 'get-trader-alerts', rateLimit: 'authenticated' }
)

/** POST — publication hold: new and updated configurations are unavailable. */
export const POST = withAuth(
  async () => {
    // withAuth performs authentication and CSRF validation before this handler.
    // Do not parse the body or query tables: V1 must not create, update, or
    // re-enable an alert that cannot be automatically evaluated or delivered.
    return NextResponse.json(
      {
        success: false,
        available: TRADER_ALERTS_PUBLISHED,
        code: TRADER_ALERTS_NOT_PUBLISHED_CODE,
        error: TRADER_ALERTS_UNAVAILABLE_MESSAGE,
      },
      { status: 503, headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  },
  { name: 'post-trader-alerts', rateLimit: 'authenticated' }
)

/** DELETE — remove an authenticated owner's legacy configuration. */
export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const alertId = searchParams.get('id')
    const traderId = searchParams.get('trader_id')
    const source = searchParams.get('source')

    if (!alertId && !traderId) {
      return NextResponse.json(
        { success: false, error: 'Either id or trader_id is required' },
        { status: 400, headers: TRADER_ALERTS_NO_STORE_HEADERS }
      )
    }

    let query = supabase.from('trader_alerts').delete().eq('user_id', user.id)

    if (alertId) {
      query = query.eq('id', alertId)
    } else if (traderId) {
      query = query.eq('trader_id', traderId)
      if (source) query = query.eq('source', source)
    }

    const { error: deleteError } = await query

    if (deleteError) {
      logger.error('[trader-alerts] 删除Failed:', deleteError)
      throw new Error('Failed to delete alert config')
    }

    return NextResponse.json(
      { success: true, data: { deleted: true } },
      { headers: TRADER_ALERTS_NO_STORE_HEADERS }
    )
  },
  { name: 'delete-trader-alerts', rateLimit: 'authenticated' }
)
