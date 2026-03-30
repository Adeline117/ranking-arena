/**
 * Admin API: Anomaly Statistics
 * GET /api/admin/anomalies/stats - Get aggregated anomaly statistics
 *
 * @module app/api/admin/anomalies/stats
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getAnomalyStats } from '@/lib/services/anomaly-manager'
import logger from '@/lib/logger'

// Verify admin access
async function verifyAdmin(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.substring(7)
  const supabase = getSupabaseAdmin()

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    return false
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single()

  return profile?.is_admin === true
}

export async function GET(request: NextRequest) {
  try {
    // Verify admin access
    const isAdmin = await verifyAdmin(request)
    if (!isAdmin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Fetch statistics
    const stats = await getAnomalyStats()

    return NextResponse.json({
      success: true,
      data: stats,
    })
  } catch (error: unknown) {
    logger.error('[Admin Anomalies] Error fetching stats:', error)

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch statistics',
        code: 'INTERNAL_ERROR',
      },
      { status: 500 }
    )
  }
}
