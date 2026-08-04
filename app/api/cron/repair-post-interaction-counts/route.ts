/**
 * Drain durable reaction/vote counter repair obligations.
 *
 * This is intentionally separate from the legacy-named batch-5min route: that
 * route runs every 15 minutes and refreshes hot scores through a different
 * bulk-write lock domain. Counter repair needs its own five-minute heartbeat.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { repairPostInteractionCountsInline } from '@/lib/cron/inline-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

export const GET = withCron(
  'repair-post-interaction-counts',
  async (_request: NextRequest) => {
    const workSignal = AbortSignal.timeout(80_000)
    const result = await repairPostInteractionCountsInline(workSignal)

    if (result.status !== 'success') {
      throw new Error(result.error || 'post interaction count repair failed')
    }

    const processedCount = result.detail?.processedCount
    if (!Number.isSafeInteger(processedCount) || Number(processedCount) < 0) {
      throw new Error('post interaction count repair returned invalid telemetry')
    }

    return {
      count: processedCount as number,
      result,
    }
  },
  { safetyTimeoutMs: 85_000 }
)
