/**
 * Admin API: Anomaly List
 * GET /api/admin/anomalies - List all anomalies with filtering
 *
 * @module app/api/admin/anomalies
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAllAnomalies, type GetAnomaliesOptions } from '@/lib/services/anomaly-manager'
import logger from '@/lib/logger'

// Verify admin access
async function verifyAdmin(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return false
  }

  const token = authHeader.substring(7)
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return false
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

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

    // Parse query parameters
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') as GetAnomaliesOptions['status'] | null
    const severity = searchParams.get('severity') as GetAnomaliesOptions['severity'] | null
    const platform = searchParams.get('platform')
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    // Fetch anomalies
    const options: GetAnomaliesOptions & { platform?: string } = {
      limit,
      offset,
    }

    if (status) options.status = status
    if (severity) options.severity = severity
    if (platform) options.platform = platform

    const anomalies = await getAllAnomalies(options)

    return NextResponse.json({
      success: true,
      data: anomalies,
      meta: {
        limit,
        offset,
        has_more: anomalies.length === limit,
      },
    })
  } catch (error: unknown) {
    logger.error('[Admin Anomalies] Error fetching anomalies:', error)

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch anomalies',
      },
      { status: 500 }
    )
  }
}
