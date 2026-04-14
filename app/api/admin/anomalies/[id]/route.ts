/**
 * Admin API: Anomaly Detail & Update
 * GET /api/admin/anomalies/[id] - Get anomaly details
 * PATCH /api/admin/anomalies/[id] - Update anomaly status
 *
 * @module app/api/admin/anomalies/[id]
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { updateAnomalyStatus } from '@/lib/services/anomaly-manager'
import logger from '@/lib/logger'

// Verify admin access and get user ID
async function verifyAdminAndGetUserId(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.substring(7)
  const supabase = getSupabaseAdmin() as SupabaseClient

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return null
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single()

  if (profile?.is_admin !== true) {
    return null
  }

  return user.id
}

// GET: Fetch anomaly details
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await verifyAdminAndGetUserId(request)
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const anomalyId = params.id

    const supabase = getSupabaseAdmin() as SupabaseClient

    const { data, error } = await supabase
      .from('trader_anomalies')
      .select('id, platform, market_type, trader_key, anomaly_type, severity, status, details, detected_at, resolved_at, resolved_by, notes, created_at')
      .eq('id', anomalyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { success: false, error: 'Anomaly not found' },
          { status: 404 }
        )
      }
      throw error
    }

    return NextResponse.json({
      success: true,
      data,
    })
  } catch (error: unknown) {
    logger.error('[Admin Anomalies] Error fetching anomaly:', error)

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch anomaly',
        code: 'INTERNAL_ERROR',
      },
      { status: 500 }
    )
  }
}

// PATCH: Update anomaly status
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await verifyAdminAndGetUserId(request)
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const anomalyId = params.id
    const body = await request.json()

    // Validate request body
    const { status, notes } = body

    if (!status || !['confirmed', 'false_positive', 'resolved'].includes(status)) {
      return NextResponse.json(
        { success: false, error: 'Invalid status. Must be: confirmed, false_positive, or resolved' },
        { status: 400 }
      )
    }

    // Update anomaly
    await updateAnomalyStatus(anomalyId, status, notes, userId)

    return NextResponse.json({
      success: true,
      message: 'Anomaly updated successfully',
    })
  } catch (error: unknown) {
    logger.error('[Admin Anomalies] Error updating anomaly:', error)

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update anomaly',
        code: 'INTERNAL_ERROR',
      },
      { status: 500 }
    )
  }
}
