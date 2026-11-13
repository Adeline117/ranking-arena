/**
 * Cron: Auto-post daily market summary
 *
 * Publication is intentionally paused until an immutable publication receipt
 * can prove every ranked and market metric in a generated post.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PUBLICATION_EVIDENCE_UNAVAILABLE = 'arena_bot_publication_evidence_unavailable'

const handler = withCron(
  'auto-post-market-summary',
  async (_request: NextRequest) => {
    // Fail closed before any source read, system-user provisioning, or post write.
    return {
      count: 0,
      skipped: true,
      reason: PUBLICATION_EVIDENCE_UNAVAILABLE,
      ranking_visibility: 'unknown',
    }
  },
  { maxDurationSec: maxDuration }
)

export const GET = handler

// Keep the existing alternate cron method behind the same authentication wrapper.
export async function POST(request: NextRequest) {
  return handler(request)
}
