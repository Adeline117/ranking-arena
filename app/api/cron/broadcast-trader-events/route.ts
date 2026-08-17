/**
 * GET /api/cron/broadcast-trader-events
 *
 * Ranking-derived follower broadcasts are intentionally paused. The former
 * implementation combined current performance rows with historical records,
 * but neither path has a public, immutable history-provenance contract.
 *
 * Position notices are paused too: their legacy audience/source resolution was
 * coupled to that same ranking input. Re-enable only with an independently
 * reviewed exact-account evidence contract.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

const PROVENANCE_UNAVAILABLE_REASON = 'ranking event provenance unavailable'

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('broadcast-trader-events', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const plog = await PipelineLogger.start('broadcast-trader-events')
  try {
    // Fail closed: do not read performance data, write notification rows, or
    // dispatch pushes until both sides of a historical event are proven.
    logger.info(`[broadcast-trader-events] skipped: ${PROVENANCE_UNAVAILABLE_REASON}`)
    await plog.success(0, {
      reason: PROVENANCE_UNAVAILABLE_REASON,
      ranking_visibility: 'unknown',
    })
    return NextResponse.json({
      status: 'skipped',
      reason: PROVENANCE_UNAVAILABLE_REASON,
      ranking_visibility: 'unknown',
      events: 0,
      notified: 0,
    })
  } catch (err) {
    logger.error('[broadcast-trader-events] failed', err)
    await plog.error(err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  } finally {
    releaseLock()
  }
}
