/**
 * GET /api/cron/sync-ranking-store
 *
 * Keeps the near-real-time ranking Redis sorted set (`ranking:live:<season>`,
 * read by /api/rankings/live) in sync with `leaderboard_ranks.arena_score`.
 *
 * Why a dedicated cron (2026-07-09): compute-leaderboard already syncs the
 * sorted set, but only via `fireAndForget(syncRedisSortedSet(...))` at the very
 * end of the handler — so on a time-tight compute run the serverless function
 * returns and KILLS the sync mid-flight, leaving the live ranking stale (this
 * exact gap left /api/rankings/live showing the old V3 order for hours after
 * the v4 cutover). This cron re-syncs independently of compute's time budget,
 * so the live ranking can never drift for more than one cron interval.
 *
 * syncSortedSetFromLeaderboard is a full DEL + rebuild from leaderboard_ranks,
 * so it is idempotent and self-correcting regardless of prior state.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { syncSortedSetFromLeaderboard } from '@/lib/realtime/ranking-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SEASONS = ['7D', '30D', '90D'] as const

export const GET = withCron('sync-ranking-store', async (_request: NextRequest, { supabase }) => {
  const synced: Record<string, number> = {}
  for (const season of SEASONS) {
    synced[season] = await syncSortedSetFromLeaderboard(supabase, season)
  }
  const count = Object.values(synced).reduce((a, b) => a + b, 0)
  return { count, synced }
})
