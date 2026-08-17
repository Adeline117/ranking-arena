/**
 * GET /api/feed/activities/[id]
 *
 * Fetch a single trader activity by ID.
 * Used by the share page for OG card rendering.
 *
 * @module app/api/feed/activities/[id]
 */

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextRequest } from 'next/server'
import { getSupabaseAdmin, success, handleError, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { NextResponse } from 'next/server'
import {
  hasPublicNonRankingActivityTypes,
  isPublicNonRankingActivity,
  noStorePublicActivity,
} from '@/lib/feed/public-activity-policy'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return noStorePublicActivity(rateLimitResponse)

  const { id } = await params

  if (!id) {
    return noStorePublicActivity(
      NextResponse.json({ error: 'Missing activity ID' }, { status: 400 })
    )
  }

  // A share URL is a public reader too. With no event-time-attested public
  // type, fail closed before even looking up the historical row.
  if (!hasPublicNonRankingActivityTypes()) {
    return noStorePublicActivity(
      NextResponse.json({ error: 'Activity not found' }, { status: 404 })
    )
  }

  try {
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('trader_activities')
      .select(
        'id, source, source_trader_id, handle, avatar_url, activity_type, activity_text, metric_value, metric_label, occurred_at'
      )
      .eq('id', id)
      .single()

    if (error || !data || !isPublicNonRankingActivity(data)) {
      return noStorePublicActivity(
        NextResponse.json({ error: 'Activity not found' }, { status: 404 })
      )
    }

    return noStorePublicActivity(success(data))
  } catch (err) {
    return noStorePublicActivity(handleError(err))
  }
}
