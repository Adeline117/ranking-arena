/**
 * GET/PATCH /api/admin/manipulation/alerts/[alertId]
 *
 * Admin API for managing individual manipulation alerts
 *
 * GET - Get alert details
 * PATCH - Update alert (resolve, dismiss, escalate)
 *
 * Auth: Admin role required
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface AlertUpdateRequest {
  status?: 'active' | 'investigating' | 'resolved' | 'false_positive'
  resolution_notes?: string
}

// ============================================
// GET - Get Alert Details
// ============================================

export async function GET(
  request: NextRequest,
  { params }: { params: { alertId: string } }
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Auth check - require admin role
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data: { user: getUser }, error: getAuthError } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', '')
  )
  if (getAuthError || !getUser) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }
  const { data: getProfile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', getUser.id)
    .single()
  if (getProfile?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { alertId } = params

  try {
    // Fetch alert with related data
    const { data: alert, error } = await supabase
      .from('manipulation_alerts')
      .select(`
        *,
        trader_flags:trader_flags(*)
      `)
      .eq('id', alertId)
      .single()

    if (error) {
      logger.dbError('fetch-alert-details', error, { alertId })
      return NextResponse.json(
        { error: 'Failed to fetch alert', details: error.message },
        { status: 500 }
      )
    }

    if (!alert) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
    }

    // Fetch history
    const { data: history } = await supabase
      .from('manipulation_alert_history')
      .select('*')
      .eq('alert_id', alertId)
      .order('created_at', { ascending: false })

    return NextResponse.json({
      alert,
      history: history || [],
    })
  } catch (error) {
    logger.apiError(`/api/admin/manipulation/alerts/${alertId}`, error, {})
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    )
  }
}

// ============================================
// PATCH - Update Alert
// ============================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: { alertId: string } }
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const { alertId } = params

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

    // Verify admin role
    const { data: patchProfile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single()
    if (patchProfile?.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Get current alert
    const { data: currentAlert, error: fetchError } = await supabase
      .from('manipulation_alerts')
      .select('*')
      .eq('id', alertId)
      .single()

    if (fetchError || !currentAlert) {
      return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
    }

    // Parse update request
    const update: AlertUpdateRequest = await request.json()

    if (!update.status && !update.resolution_notes) {
      return NextResponse.json(
        { error: 'No update fields provided' },
        { status: 400 }
      )
    }

    // Build update object
    const updateData: Record<string, any> = {}

    if (update.status) {
      updateData.status = update.status

      // Set resolved_at and resolved_by if resolving
      if (update.status === 'resolved' || update.status === 'false_positive') {
        updateData.resolved_at = new Date().toISOString()
        updateData.resolved_by = user.id
      }
    }

    if (update.resolution_notes) {
      updateData.resolution_notes = update.resolution_notes
    }

    // Update alert
    const { data: updatedAlert, error: updateError } = await supabase
      .from('manipulation_alerts')
      .update(updateData)
      .eq('id', alertId)
      .select()
      .single()

    if (updateError) {
      logger.dbError('update-alert', updateError, { alertId, update })
      return NextResponse.json(
        { error: 'Failed to update alert', details: updateError.message },
        { status: 500 }
      )
    }

    // If resolved or false positive, clear associated trader flags
    if (update.status === 'resolved' || update.status === 'false_positive') {
      await supabase
        .from('trader_flags')
        .update({ flag_status: 'cleared' })
        .eq('alert_id', alertId)
        .in('flag_status', ['flagged', 'suspended'])
    }

    // Log to history
    await supabase.from('manipulation_alert_history').insert({
      alert_id: alertId,
      action: update.status ? 'resolved' : 'updated',
      performed_by: user.id,
      old_status: currentAlert.status,
      new_status: update.status || currentAlert.status,
      notes: update.resolution_notes || 'Alert updated via admin API',
    })

    return NextResponse.json({
      success: true,
      alert: updatedAlert,
    })
  } catch (error) {
    logger.apiError(`/api/admin/manipulation/alerts/${alertId}`, error, {})
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    )
  }
}
