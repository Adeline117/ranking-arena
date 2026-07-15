/**
 * POST /api/trader/sync
 *
 * Compatibility entrypoint for callers that request an authorized-trader
 * refresh. Exchange access and persistence run exclusively on the ingest
 * worker; this route only selects eligible authorizations and enqueues them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { enqueueFirstPartySync } from '@/lib/ingest/first-party/enqueue'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SyncRequest {
  authorizationId?: string
  userId?: string
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json()) as SyncRequest
    const supabase = getSupabaseAdmin()
    let query = supabase
      .from('trader_authorizations')
      .select('id')
      .eq('status', 'active')
      .not('read_only_verified_at', 'is', null)

    if (body.authorizationId) query = query.eq('id', body.authorizationId)
    if (body.userId) query = query.eq('user_id', body.userId)

    const { data: authorizations, error } = await query
    if (error) {
      logger.dbError('queue-first-party-sync', error, {})
      return NextResponse.json({ error: 'Failed to fetch authorizations' }, { status: 500 })
    }
    if (body.authorizationId && authorizations?.length === 0) {
      return NextResponse.json({ error: 'Authorization not found' }, { status: 404 })
    }

    const results = await Promise.all(
      (authorizations || []).map(async ({ id }) => ({
        id,
        queued: await enqueueFirstPartySync(id),
      }))
    )
    const queued = results.filter((result) => result.queued).length

    return NextResponse.json({
      success: queued === results.length,
      queued,
      errors: results.length - queued,
      total: results.length,
    })
  } catch (error) {
    logger.apiError('/api/trader/sync', error, {})
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
