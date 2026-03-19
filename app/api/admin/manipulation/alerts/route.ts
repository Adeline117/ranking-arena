/**
 * GET/POST /api/admin/manipulation/alerts
 *
 * Admin API for managing manipulation detection alerts
 *
 * GET - List alerts with filtering
 * POST - Create new alert (typically called by detection system)
 *
 * Auth: Admin role required
 */

import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface ManipulationAlert {
  alert_type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  traders: string[]
  evidence: Record<string, unknown>
  auto_action?: 'flag' | 'suspend' | 'ban' | 'none'
}

// ============================================
// GET - List Alerts
// ============================================

export async function GET(request: NextRequest) {
  const supabase = getSupabaseAdmin()

  // Auth check
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Verify admin role
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )

    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Check if user has admin role
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Parse query params
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'active'
    const severity = searchParams.get('severity')
    const alertType = searchParams.get('alert_type')
    const limit = parseInt(searchParams.get('limit') || '100', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    // Build query
    let query = supabase
      .from('manipulation_alerts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    if (severity) {
      query = query.eq('severity', severity)
    }

    if (alertType) {
      query = query.eq('alert_type', alertType)
    }

    const { data: alerts, error, count } = await query

    if (error) {
      logger.dbError('fetch-manipulation-alerts', error, { status, severity, alertType })
      return NextResponse.json(
        { error: 'Failed to fetch alerts' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      alerts: alerts || [],
      total: count || 0,
      limit,
      offset,
    })
  } catch (error) {
    logger.apiError('/api/admin/manipulation/alerts', error, {})
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ============================================
// POST - Create Alert
// ============================================

export async function POST(request: NextRequest) {
  const supabase = getSupabaseAdmin()

  // Auth check (allow cron secret or admin)
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if it's cron secret
  const isCronJob = env.CRON_SECRET && authHeader === `Bearer ${env.CRON_SECRET}`

  // If not cron, verify admin role
  if (!isCronJob) {
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authError || !user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()
    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
  }

  try {
    // Parse request body
    const alert: ManipulationAlert = await request.json()

    // Validate required fields
    if (!alert.alert_type || !alert.severity || !alert.traders || !alert.evidence) {
      return NextResponse.json(
        { error: 'Missing required fields: alert_type, severity, traders, evidence' },
        { status: 400 }
      )
    }

    if (!Array.isArray(alert.traders) || alert.traders.length === 0) {
      return NextResponse.json(
        { error: 'traders must be a non-empty array' },
        { status: 400 }
      )
    }

    // Insert alert
    const { data: insertedAlert, error: insertError } = await supabase
      .from('manipulation_alerts')
      .insert({
        alert_type: alert.alert_type,
        severity: alert.severity,
        traders: alert.traders,
        evidence: alert.evidence,
        auto_action: alert.auto_action || 'none',
        status: 'active',
      })
      .select()
      .single()

    if (insertError) {
      logger.dbError('insert-manipulation-alert', insertError, { alert })
      return NextResponse.json(
        { error: 'Failed to create alert' },
        { status: 500 }
      )
    }

    // If auto_action is specified, create trader flags
    if (alert.auto_action && alert.auto_action !== 'none') {
      const flagStatus = alert.auto_action // 'flag', 'suspend', or 'ban'

      for (const traderIdStr of alert.traders) {
        const [platform, traderId] = traderIdStr.split(':')

        if (!platform || !traderId) {
          logger.warn('Invalid trader ID format', { traderIdStr })
          continue
        }

        // Determine expiration based on severity
        let expiresAt: string | null = null
        if (flagStatus === 'flag') {
          // Flagged expires after 30 days
          const expireDate = new Date()
          expireDate.setDate(expireDate.getDate() + 30)
          expiresAt = expireDate.toISOString()
        }

        const { error: flagError } = await supabase
          .from('trader_flags')
          .insert({
            platform,
            trader_key: traderId,
            flag_status: flagStatus,
            reason: alert.alert_type,
            alert_id: insertedAlert.id,
            expires_at: expiresAt,
          })

        if (flagError) {
          // Ignore unique constraint violations (flag already exists)
          if (!flagError.message.includes('duplicate') && !flagError.message.includes('unique')) {
            logger.dbError('insert-trader-flag', flagError, { platform, traderId, alertId: insertedAlert.id })
          }
        }
      }
    }

    // Log alert creation to history
    await supabase.from('manipulation_alert_history').insert({
      alert_id: insertedAlert.id,
      action: 'created',
      new_status: 'active',
      notes: `Alert created via ${isCronJob ? 'automated detection' : 'admin API'}`,
    })

    return NextResponse.json({
      success: true,
      alert: insertedAlert,
    })
  } catch (error) {
    logger.apiError('/api/admin/manipulation/alerts', error, {})
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
