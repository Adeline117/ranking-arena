/**
 * DB-driven scheduler reconciliation (spec §2.3 cadence tiers).
 *
 * arena.sources is the single source of orchestration config: this reads
 * all active sources and upserts BullMQ job schedulers per tier. Runs at
 * boot and hourly — flipping a source active/inactive or changing a
 * cadence in the DB takes effect without a deploy.
 */

import { getActiveSources } from '@/lib/ingest/sources'
import { getIngestQueue, INGEST_JOB } from './queues'

/** Maintenance jobs are framework-level, not per-source. */
const STATIC_SCHEDULERS = [
  { id: 'maint:housekeeping', name: INGEST_JOB.MAINTENANCE, everyMs: 6 * 3600_000 },
  { id: 'maint:freshness', name: INGEST_JOB.FRESHNESS, everyMs: 30 * 60_000 },
  // 2h cadence until the 72k-trader backfill drains (≈12 days at 500/batch);
  // steady-state weekly refresh is naturally rate-limited by the 7d staleness check.
  { id: 'maint:avatar-mirror', name: INGEST_JOB.AVATAR_MIRROR, everyMs: 2 * 3600_000 },
  { id: 'maint:daily-digest', name: INGEST_JOB.DAILY_DIGEST, everyMs: 24 * 3600_000 },
] as const

export async function reconcileSchedulers(): Promise<void> {
  const queue = getIngestQueue()
  const sources = await getActiveSources()
  const wanted = new Set<string>()

  for (const src of sources) {
    const data = { sourceSlug: src.slug }

    const tierA = `tiera:${src.slug}`
    wanted.add(tierA)
    await queue.upsertJobScheduler(
      tierA,
      { every: src.cadence_tier_a_seconds * 1000 },
      { name: INGEST_JOB.TIER_A, data }
    )

    const tierB = `tierb:${src.slug}`
    wanted.add(tierB)
    await queue.upsertJobScheduler(
      tierB,
      { every: src.cadence_tier_b_seconds * 1000 },
      { name: INGEST_JOB.TIER_B, data }
    )

    const tierD = `tierd:${src.slug}`
    wanted.add(tierD)
    await queue.upsertJobScheduler(
      tierD,
      { every: src.cadence_tier_d_seconds * 1000 },
      { name: INGEST_JOB.TIER_D, data }
    )

    // Derived boards (MEXC/BTCC): synthesize after each Tier-A cadence.
    if (src.timeframes_derived.length > 0) {
      const derive = `derive:${src.slug}`
      wanted.add(derive)
      await queue.upsertJobScheduler(
        derive,
        { every: src.cadence_tier_a_seconds * 1000 },
        { name: INGEST_JOB.DERIVE_BOARDS, data }
      )
    }
  }

  for (const s of STATIC_SCHEDULERS) {
    wanted.add(s.id)
    await queue.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.name, data: {} })
  }

  // Remove schedulers for sources that were deactivated/dropped.
  const existing = await queue.getJobSchedulers()
  for (const scheduler of existing) {
    if (scheduler.id && !wanted.has(scheduler.id)) {
      await queue.removeJobScheduler(scheduler.id)
      console.log(`[ingest-scheduler] removed stale scheduler ${scheduler.id}`)
    }
  }

  console.log(
    `[ingest-scheduler] reconciled: ${sources.length} active sources, ` +
      `${wanted.size} schedulers`
  )
}
