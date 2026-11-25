/**
 * Legacy ranking command-chain scheduler.
 *
 * ENDGAME (ARENA_DATA_SPEC v1.2): all leaderboard fetching + enrichment moved
 * to the arena-ingest-worker (worker/src/ingest/). Its historical role was
 * score recompute and Meilisearch sync. The V1 gate returns before resolving
 * or mutating BullMQ; it cannot stop a scheduler already persisted elsewhere.
 */

import { isV1RankingCommandChainPublished } from '../../lib/cron/v1-ranking-command-chain-publication'
import { RANK_PUBLICATION_INTERVAL_HOURS } from '../../lib/rankings/publication/source-publication-evidence'
import type { ComputeLeaderboardData } from './queues'

// The publish-side freshness margin is derived from this cadence.
const SCORE_INTERVALS_MS = RANK_PUBLICATION_INTERVAL_HOURS * 3600_000

/**
 * Register all repeatable jobs. Idempotent — BullMQ deduplicates by scheduler ID.
 */
export async function registerSchedules(): Promise<void> {
  // Do not even resolve the BullMQ queue while V1 keeps this retired command
  // chain unpublished. In particular, do not mutate persisted schedulers as
  // part of this source-only containment.
  if (!isV1RankingCommandChainPublished()) {
    console.error(
      '[RETIRED] V1 ranking command chain is not published; schedules remain untouched.'
    )
    return
  }

  const { getQueue, JOB } = await import('./queues')
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
