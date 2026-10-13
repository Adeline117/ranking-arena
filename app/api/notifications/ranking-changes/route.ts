/**
 * Ranking-change notifications are paused until rank history has an immutable
 * public provenance contract. A partial, raw, or unavailable historical row
 * must never become a user-visible rank or performance notification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

const PROVENANCE_UNAVAILABLE_REASON = 'ranking event provenance unavailable'

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('ranking-change-notifications')
  try {
    // Fail closed: no current or historical ranking data is read and no
    // notification is inserted until both observations are proven publishable.
    await plog.success(0, {
      reason: PROVENANCE_UNAVAILABLE_REASON,
      ranking_visibility: 'unknown',
    })
    return NextResponse.json({
      ok: true,
      status: 'skipped',
      reason: PROVENANCE_UNAVAILABLE_REASON,
      ranking_visibility: 'unknown',
      notifications: 0,
    })
  } catch (err) {
    await plog.error(err instanceof Error ? err : new Error(String(err)))
    logger.error('[Notifications] Ranking changes error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
