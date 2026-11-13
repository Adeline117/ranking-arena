/**
 * Cron: Generate trader activity feed events
 * Schedule: Every 6 hours (after compute-leaderboard)
 *
 * Ranking-derived activity generation is intentionally paused. Existing
 * activity rows do not have an immutable event-time publication receipt, so
 * raw leaderboard data must not be turned into a public historical claim.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { withCron } from '@/lib/api/with-cron'

const log = createLogger('cron:generate-activities')

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const RANKING_ACTIVITY_EVIDENCE_UNAVAILABLE =
  'historical_ranking_activity_evidence_unavailable'

export const GET = withCron(
  'generate-activities',
  async (_request: NextRequest) => {
    const supabase = getSupabaseAdmin()

    // Keep the existing retention job for explicitly non-ranking events. It also
    // bounds old private ranking rows while a future event-level publication
    // substrate is designed; no raw leaderboard row is read or written here.
    await supabase
      .from('trader_activities')
      .delete()
      .lt('occurred_at', new Date(Date.now() - 30 * 86400000).toISOString())

    log.info('Skipped ranking activity generation: event-time evidence unavailable')
    return { count: 0, reason: RANKING_ACTIVITY_EVIDENCE_UNAVAILABLE }
  },
  { maxDurationSec: maxDuration }
)
