/**
 * GET /api/feed/activities/[id]
 *
 * Fetch a single trader activity by ID.
 * Used by the share page for OG card rendering.
 *
 * @module app/api/feed/activities/[id]
 */

export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { NextResponse } from 'next/server'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  const { id } = await params

  if (!id) {
    return NextResponse.json({ error: 'Missing activity ID' }, { status: 400 })
  }

  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('trader_activities')
      .select('id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at')
      .eq('id', id)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    }

    return success(data)
  } catch (err) {
    return handleError(err)
  }
}
