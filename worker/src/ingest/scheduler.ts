/**
 * DB-driven scheduler reconciliation (spec §2.3 cadence tiers).
 *
 * arena.sources is the single source of orchestration config: this reads
 * all active sources and upserts BullMQ job schedulers per tier. Runs at
 * boot and hourly — flipping a source active/inactive or changing a
 * cadence in the DB takes effect without a deploy.
 */

import { getActiveSources } from '@/lib/ingest/sources'
import {
  FAST_LANE_ENABLED,
  getFastQueue,
  getIngestQueue,
  getRegionQueue,
  INGEST_JOB,
  INGEST_REGIONS,
  isFastTierA,
  regionFastQueueName,
  regionQueueName,
} from './queues'

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
  // scheduler key → the queue NAME it must live on. A Set isn't enough: a
  // source can MOVE between the bulk and fast lanes (board grows past
  // FAST_TIER_A_MAX_COUNT), and the cleanup pass must then remove the stale
  // tiera:<slug> from the OLD queue — but the key is still "wanted", just on a
  // different queue. So cleanup keys off (key, queueName), not key alone.
  const wanted = new Map<string, string>()

  for (const src of sources) {
    const data = { sourceSlug: src.slug }
    // Bulk tiers run on the source's fetch_region queue so a worker
    // co-located with that region picks them up (remote-WS chain gone).
    const queue = getRegionQueue(src.fetch_region)
    const bulkName = regionQueueName(src.fetch_region)

    // ── Tier-A lane split (2026-06-13 slot-starvation root fix) ──
    // BullMQ priority alone can't fix this: priority picks which job grabs a
    // FREED slot, but never preempts a running one — so a giant multi-hour
    // crawl (bybit_mt5 ≈29k traders/2-3h) holds a slot for hours and the small
    // user-facing leaderboards behind it sit 14-24h stale. Light Tier-A
    // (board ≤ FAST_TIER_A_MAX_COUNT) is siphoned to a SEPARATE fast-lane queue
    // + worker pool that the giants can never touch; heavy Tier-A + all
    // Tier-B/D/series/derive stay on the bulk queue. Priority 1 still applies
    // within the fast lane.
    const onFast = FAST_LANE_ENABLED && isFastTierA(src.expected_count)
    const tierAQueue = onFast ? getFastQueue(src.fetch_region) : queue
    const tierAName = onFast ? regionFastQueueName(src.fetch_region) : bulkName
    const tierA = `tiera:${src.slug}`
    wanted.set(tierA, tierAName)
    await tierAQueue.upsertJobScheduler(
      tierA,
      { every: src.cadence_tier_a_seconds * 1000 },
      { name: INGEST_JOB.TIER_A, data, opts: { priority: 1 } }
    )

    const tierB = `tierb:${src.slug}`
    wanted.set(tierB, bulkName)
    await queue.upsertJobScheduler(
      tierB,
      { every: src.cadence_tier_b_seconds * 1000 },
      { name: INGEST_JOB.TIER_B, data, opts: { priority: 6 } }
    )

    const tierD = `tierd:${src.slug}`
    wanted.set(tierD, bulkName)
    await queue.upsertJobScheduler(
      tierD,
      { every: src.cadence_tier_d_seconds * 1000 },
      { name: INGEST_JOB.TIER_D, data, opts: { priority: 3 } }
    )

    // Series backfill (spec §13.1): slow sweep of ranked traders beyond
    // deep_profile_topn — only for sources that opt in via
    // meta.series_backfill_topn. Default 30-min cadence drips a bounded batch
    // so long-tail chart coverage grows over days within the rate budget.
    const backfillTopN = Number(src.meta?.series_backfill_topn ?? 0)
    if (backfillTopN > src.deep_profile_topn) {
      const cadenceSec = Number(src.meta?.series_backfill_cadence_seconds ?? 1800)
      const seriesBackfill = `tierbs:${src.slug}`
      wanted.set(seriesBackfill, bulkName)
      await queue.upsertJobScheduler(
        seriesBackfill,
        { every: Math.max(60, cadenceSec) * 1000 },
        { name: INGEST_JOB.TIER_B_SERIES, data, opts: { priority: 9 } }
      )
    }

    // Derived boards (MEXC/BTCC): synthesize after each Tier-A cadence.
    if (src.timeframes_derived.length > 0) {
      const derive = `derive:${src.slug}`
      wanted.set(derive, bulkName)
      await queue.upsertJobScheduler(
        derive,
        { every: src.cadence_tier_a_seconds * 1000 },
        { name: INGEST_JOB.DERIVE_BOARDS, data, opts: { priority: 2 } }
      )
    }
  }

  // Framework maintenance always runs on the primary (local) node.
  const localQueue = getIngestQueue()
  for (const s of STATIC_SCHEDULERS) {
    wanted.set(s.id, regionQueueName('local'))
    await localQueue.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.name, data: {} })
  }

  // Remove stale schedulers + REVIVE stuck ones across every region queue.
  //
  // Stuck-scheduler root fix, take 2 (2026-06-12): the first version of this
  // block read `scheduler.id`, but getJobSchedulers() items carry the
  // scheduler identifier in `key` — `id` is always undefined, so the guard
  // `if (!scheduler.id) continue` skipped EVERY scheduler and both cleanup
  // and revival were dead code (15 sources sat 20h+ stale while hourly
  // reconciles logged success).
  //
  // Revival predicate is now exact instead of a loose 2×cadence window: a
  // scheduler iteration job has the deterministic id `repeat:<key>:<next>`.
  // If `next` is past grace AND that job is gone, the repeat chain is broken
  // (a backlogged-but-queued iteration still has its job and is left alone).
  const REVIVE_GRACE_MS = 5 * 60_000
  let revived = 0
  const now = Date.now()
  // Walk BOTH lanes per region: a scheduler on the wrong lane (key wanted, but
  // queueName mismatch) is stale and must be removed so the source doesn't run
  // on two queues at once after a bulk⇄fast migration.
  const queuesToWalk = INGEST_REGIONS.flatMap((region) => [
    { q: getRegionQueue(region), name: regionQueueName(region) },
    { q: getFastQueue(region), name: regionFastQueueName(region) },
  ])
  for (const { q, name: queueName } of queuesToWalk) {
    const existing = await q.getJobSchedulers()
    for (const scheduler of existing) {
      const key = scheduler.key
      if (!key) continue
      if (wanted.get(key) !== queueName) {
        await q.removeJobScheduler(key)
        console.log(`[ingest-scheduler] removed stale scheduler ${key} (${queueName})`)
        continue
      }
      const every = typeof scheduler.every === 'number' ? scheduler.every : Number(scheduler.every)
      if (!scheduler.next || !every || scheduler.next >= now - REVIVE_GRACE_MS) continue
      const overdueMs = now - scheduler.next
      const iterationJob = await q.getJob(`repeat:${key}:${scheduler.next}`)
      let reason: string
      if (!iterationJob) {
        reason = 'iteration job missing'
      } else {
        // Iteration EXISTS. Normally that means it's queued behind a backlog —
        // leave it. BUT (2026-06-13 take-3): a starved iteration can sit in
        // `waiting` for 10h+ while priority-1 jobs jump ahead; the scheduler
        // won't advance past a never-running iteration → permanent deadlock
        // (bitget×5/gate_cfd/blofin/btcc all stuck 17-36h, raw_objects + snapshots
        // both frozen). So: if BADLY overdue (>2× cadence) AND the iteration is
        // NOT currently running, rebuild to break the deadlock — but never
        // interrupt an active long crawl (25-90min Tier-A).
        const state = await iterationJob.getState().catch(() => 'unknown')
        if (overdueMs < 2 * every || state === 'active') continue
        reason = `iteration stuck in ${state}`
      }
      const tmplData = scheduler.template?.data ?? {}
      await q.removeJobScheduler(key)
      await q.upsertJobScheduler(key, { every }, { name: scheduler.name, data: tmplData })
      // CRITICAL (2026-06-13 take-4): upsertJobScheduler's first iteration only
      // fires after a full `every` interval — for a 5h-cadence Tier-A that means
      // a revived source waits 5h to crawl (bitget×5 sat idle 1.5h post-revival
      // producing zero RAW). Enqueue an immediate priority-1 one-off so the
      // source crawls NOW; the scheduler then resumes its normal cadence.
      //
      // take-5 (2026-06-13): jobId MUST NOT contain ':' — BullMQ throws
      // "Custom Id cannot contain :" and, because this add() is awaited inside
      // the reconcile loop, the throw aborted the ENTIRE reconcile (every
      // later source skipped). `key` is `tiera:<slug>`, so the old
      // `revive-kick:${key}:${now}` template always tripped it — revival has
      // never actually kicked since take-4 shipped. Sanitize the colons.
      // Defense in depth: a kick failure must never abort the reconcile loop
      // (that was the take-4 blast radius). The scheduler is already rebuilt
      // above; the kick is a best-effort latency optimization on top.
      try {
        await q.add(scheduler.name, tmplData, {
          priority: 1,
          jobId: `revive-kick-${key.replace(/:/g, '-')}-${now}`,
          removeOnComplete: true,
          removeOnFail: { age: 3600 },
        })
      } catch (err) {
        console.error(
          `[ingest-scheduler] revive-kick for ${key} failed (scheduler still rebuilt): ` +
            (err instanceof Error ? err.message : String(err))
        )
      }
      revived++
      console.log(
        `[ingest-scheduler] revived stuck scheduler ${key} + immediate kick ` +
          `(next ${Math.round(overdueMs / 60_000)}min overdue, ${reason})`
      )
    }
  }

  console.log(
    `[ingest-scheduler] reconciled: ${sources.length} active sources, ` +
      `${wanted.size} schedulers${revived ? `, revived ${revived} stuck` : ''}`
  )
}
