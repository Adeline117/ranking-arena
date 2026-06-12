/**
 * DB-driven scheduler reconciliation (spec §2.3 cadence tiers).
 *
 * arena.sources is the single source of orchestration config: this reads
 * all active sources and upserts BullMQ job schedulers per tier. Runs at
 * boot and hourly — flipping a source active/inactive or changing a
 * cadence in the DB takes effect without a deploy.
 */

import { getActiveSources } from '@/lib/ingest/sources'
import { getIngestQueue, getRegionQueue, INGEST_JOB, INGEST_REGIONS } from './queues'

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
  const sources = await getActiveSources()
  // scheduler id → its region queue; stale cleanup walks every region.
  const wanted = new Set<string>()

  for (const src of sources) {
    const data = { sourceSlug: src.slug }
    // Bulk tiers run on the source's fetch_region queue so a worker
    // co-located with that region picks them up (remote-WS chain gone).
    const queue = getRegionQueue(src.fetch_region)

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

    // Series backfill (spec §13.1): slow sweep of ranked traders beyond
    // deep_profile_topn — only for sources that opt in via
    // meta.series_backfill_topn. Default 30-min cadence drips a bounded batch
    // so long-tail chart coverage grows over days within the rate budget.
    const backfillTopN = Number(src.meta?.series_backfill_topn ?? 0)
    if (backfillTopN > src.deep_profile_topn) {
      const cadenceSec = Number(src.meta?.series_backfill_cadence_seconds ?? 1800)
      const seriesBackfill = `tierbs:${src.slug}`
      wanted.add(seriesBackfill)
      await queue.upsertJobScheduler(
        seriesBackfill,
        { every: Math.max(60, cadenceSec) * 1000 },
        { name: INGEST_JOB.TIER_B_SERIES, data }
      )
    }

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

  // Framework maintenance always runs on the primary (local) node.
  const localQueue = getIngestQueue()
  for (const s of STATIC_SCHEDULERS) {
    wanted.add(s.id)
    await localQueue.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.name, data: {} })
  }

  // Remove stale schedulers + REVIVE stuck ones across every region queue.
  //
  // Stuck-scheduler root fix (2026-06-12): BullMQ's upsertJobScheduler is
  // idempotent when `every` is unchanged, so it does NOT advance a `next`
  // fire-time that fell into the past — which happens when a worker was
  // OOM-killed mid-crawl repeatedly: the job never completes, `next` never
  // moves, and the source silently stops scheduling forever (xt/okx_web3
  // sat at a 10h-old `next`). Detect any `next` older than ~2× its cadence
  // and force-rebuild that scheduler so it fires again.
  let revived = 0
  const now = Date.now()
  for (const region of INGEST_REGIONS) {
    const q = getRegionQueue(region)
    const existing = await q.getJobSchedulers()
    for (const scheduler of existing) {
      if (!scheduler.id) continue
      if (!wanted.has(scheduler.id)) {
        await q.removeJobScheduler(scheduler.id)
        console.log(`[ingest-scheduler] removed stale scheduler ${scheduler.id} (${region})`)
        continue
      }
      // Revive a scheduler whose next fire-time is badly overdue.
      const every = typeof scheduler.every === 'number' ? scheduler.every : Number(scheduler.every)
      if (scheduler.next && every && scheduler.next < now - 2 * every) {
        await q.removeJobScheduler(scheduler.id)
        await q.upsertJobScheduler(
          scheduler.id,
          { every },
          { name: scheduler.name, data: scheduler.template?.data ?? {} }
        )
        revived++
        console.log(
          `[ingest-scheduler] revived stuck scheduler ${scheduler.id} ` +
            `(next was ${Math.round((now - scheduler.next) / 3.6e6)}h overdue)`
        )
      }
    }
  }

  console.log(
    `[ingest-scheduler] reconciled: ${sources.length} active sources, ` +
      `${wanted.size} schedulers${revived ? `, revived ${revived} stuck` : ''}`
  )
}
