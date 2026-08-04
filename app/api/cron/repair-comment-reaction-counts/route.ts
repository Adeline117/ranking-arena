/**
 * Drain durable comment reaction counter repair obligations.
 *
 * A separate five-minute heartbeat keeps this lock domain isolated from post
 * interaction repair and guarantees one committed queue item per RPC call.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { repairCommentReactionCountsInline } from '@/lib/cron/inline-jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

export const GET = withCron(
  'repair-comment-reaction-counts',
  async (_request: NextRequest) => {
    const workSignal = AbortSignal.timeout(80_000)
    const result = await repairCommentReactionCountsInline(workSignal)

    if (result.status !== 'success') {
      throw new Error(result.error || 'comment reaction count repair failed')
    }

    const processedCount = result.detail?.processedCount
    if (!Number.isSafeInteger(processedCount) || Number(processedCount) < 0) {
      throw new Error('comment reaction count repair returned invalid telemetry')
    }

    return {
      count: processedCount as number,
      result,
    }
  },
  { safetyTimeoutMs: 85_000 }
)
