/**
 * Job scheduler — legacy pipeline residue (score + meilisearch only).
 *
 * ENDGAME (ARENA_DATA_SPEC v1.2): all leaderboard fetching + enrichment moved
 * to the arena-ingest-worker (worker/src/ingest/). This scheduler now only
 * keeps the downstream chain alive: Arena Score recompute (reads
 * public.trader_latest, which the ingest pipeline compat-writes) and
 * Meilisearch sync. Stale fetch and enrich schedulers are actively removed
 * so retired legacy jobs can never fire again.
 */

import { getQueue, JOB, type ComputeLeaderboardData } from './queues'

const SCORE_INTERVALS_MS = 2 * 3600_000 // every 2h

/**
 * Register all repeatable jobs. Idempotent — BullMQ deduplicates by scheduler ID.
 */
export async function registerSchedules(): Promise<void> {
  const queue = getQueue()

  // ENDGAME cleanup: remove every legacy fetch/enrich scheduler left in Redis
  // (upsertJobScheduler persists them; deleting code alone does not stop them).
  const existing = await queue.getJobSchedulers()
  for (const sched of existing) {
    const key = sched.key ?? sched.id
    if (key && (key.startsWith('fetch:') || key.startsWith('enrich:'))) {
      await queue.removeJobScheduler(key)
      console.log(`[scheduler] removed retired legacy scheduler ${key}`)
    }
  }

  // Score computation — staggered by 5 min per season
  const seasons: Array<{ season: '7D' | '30D' | '90D'; offsetMs: number }> = [
    { season: '7D', offsetMs: 0 },
    { season: '30D', offsetMs: 5 * 60_000 },
    { season: '90D', offsetMs: 10 * 60_000 },
  ]
  for (const { season, offsetMs } of seasons) {
    await queue.upsertJobScheduler(
      `score:${season}`,
      { every: SCORE_INTERVALS_MS, offset: offsetMs },
      {
        name: JOB.COMPUTE_LEADERBOARD,
        data: { season } satisfies ComputeLeaderboardData,
      }
    )
  }

  // Meilisearch sync — fallback schedule (event-driven also triggers after score)
  await queue.upsertJobScheduler(
    'meilisearch-sync',
    { every: 2 * 3600_000 }, // every 2h fallback
    { name: JOB.SYNC_MEILISEARCH, data: {} }
  )

  console.log(`[scheduler] Registered ${seasons.length} score + 1 meilisearch schedules`)
}
