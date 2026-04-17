/**
 * Admin API: Anomaly Detail & Update
 * GET /api/admin/anomalies/[id] - Get anomaly details
 * PATCH /api/admin/anomalies/[id] - Update anomaly status
 *
 * @module app/api/admin/anomalies/[id]
 */

import { NextRequest } from 'next/server'
import { withAdminAuth } from '@/lib/api/with-admin-auth'
import { success, notFound, badRequest } from '@/lib/api/response'
import { ApiError } from '@/lib/api/errors'
import { updateAnomalyStatus } from '@/lib/services/anomaly-manager'

// GET: Fetch anomaly details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: anomalyId } = await Promise.resolve(params)

  const handler = withAdminAuth(async ({ supabase }) => {
    const { data, error } = await supabase
      .from('trader_anomalies')
      .select('id, platform, market_type, trader_key, anomaly_type, severity, status, details, detected_at, resolved_at, resolved_by, notes, created_at')
      .eq('id', anomalyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return notFound('Anomaly not found')
      }
      throw ApiError.database('Failed to fetch anomaly')
    }

    return success(data)
  }, { name: 'admin-anomaly-detail' })

  return handler(request)
}

// PATCH: Update anomaly status
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: anomalyId } = await Promise.resolve(params)

  const handler = withAdminAuth(async ({ admin }) => {
    let body: { status?: string; notes?: string }
    try {
      body = await request.json()
    } catch {
      throw ApiError.validation('Invalid JSON in request body')
    }

    const { status: newStatus, notes } = body

    const validStatuses = ['confirmed', 'false_positive', 'resolved'] as const
    type AnomalyStatus = typeof validStatuses[number]

    if (!newStatus || !validStatuses.includes(newStatus as AnomalyStatus)) {
      return badRequest('Invalid status. Must be: confirmed, false_positive, or resolved')
    }

    // Update anomaly
    await updateAnomalyStatus(anomalyId, newStatus as AnomalyStatus, notes, admin.id)

    return success({ message: 'Anomaly updated successfully' })
  }, { name: 'admin-anomaly-update' })

  return handler(request)
}
