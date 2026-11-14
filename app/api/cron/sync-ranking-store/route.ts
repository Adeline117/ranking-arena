/**
 * GET /api/cron/sync-ranking-store
 *
 * The legacy sorted-set projection ranked score-positive rows even when the
 * database publication authority had set rank=NULL for partial, estimated, or
 * stale evidence. Public live reads now use leaderboard_ranks directly; keep
 * this scheduled endpoint as an explicit no-op until an eligibility-attested
 * Redis projection is introduced.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron(
  'sync-ranking-store',
  async (_request: NextRequest) => {
    return {
      count: 0,
      synced: {},
      disabled: 'database_rank_authority',
    }
  },
  { maxDurationSec: maxDuration }
)
