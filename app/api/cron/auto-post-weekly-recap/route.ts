/**
 * Cron: Auto-post weekly recap
 *
 * Publication is intentionally paused until an immutable publication receipt
 * can prove every ranked metric in a generated post.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'

export const maxDuration = 60

const PUBLICATION_EVIDENCE_UNAVAILABLE = 'arena_bot_publication_evidence_unavailable'

const handler = withCron(
  'auto-post-weekly-recap',
  async (_request: NextRequest) => {
    // Fail closed before any source read or post write.
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
