/**
 * DB-driven scheduler reconciliation (spec §2.3 cadence tiers).
 *
 * This is historical orchestration code. The V1 publication gate below
 * returns before reading source configuration or resolving BullMQ queues;
 * it cannot inspect, remove, or stop schedules that already exist elsewhere.
 */

import { isV1IngestExecutionPublished } from '@/lib/ingest/v1-execution-publication'

type ActiveSources = Awaited<ReturnType<typeof import('@/lib/ingest/sources').getActiveSources>>
type StaticScheduler = { id: string; name: string; everyMs: number; standby: boolean }

let getActiveSources: typeof import('@/lib/ingest/sources').getActiveSources
let getServingSourceNames: typeof import('@/lib/ingest/sources').getServingSourceNames
let EXPECTED_METRICS: typeof import('@/lib/ingest/adapters/expected-metrics').EXPECTED_METRICS
let EXPECTED_METRICS_BY_SOURCE: typeof import('@/lib/ingest/adapters/expected-metrics').EXPECTED_METRICS_BY_SOURCE
let getIngestPool: typeof import('@/lib/ingest/db').getIngestPool
let getConnection: typeof import('../connection').getConnection
let fastLaneEnabled: typeof import('./queues').fastLaneEnabled
let getFastQueue: typeof import('./queues').getFastQueue
let getIngestQueue: typeof import('./queues').getIngestQueue
let getRegionQueue: typeof import('./queues').getRegionQueue
let INGEST_JOB: typeof import('./queues').INGEST_JOB
let INGEST_REGIONS: typeof import('./queues').INGEST_REGIONS
let isFastTierA: typeof import('./queues').isFastTierA
let regionFastQueueName: typeof import('./queues').regionFastQueueName
let regionQueueName: typeof import('./queues').regionQueueName
let MAINTENANCE_STANDBY_REGIONS: readonly string[] = []
let STATIC_SCHEDULERS: readonly StaticScheduler[] = []
let SOURCE_SCOPED_JOBS = new Set<string>()
let GLOBAL_MAINTENANCE_JOBS = new Set<string>()
let schedulerRuntimeLoad: Promise<void> | undefined

function loadSchedulerRuntime(): Promise<void> {
  if (schedulerRuntimeLoad !== undefined) return schedulerRuntimeLoad

  schedulerRuntimeLoad = (async () => {
    const [sources, expectedMetrics, database, connection, queues, standby] = await Promise.all([
      import('@/lib/ingest/sources'),
      import('@/lib/ingest/adapters/expected-metrics'),
      import('@/lib/ingest/db'),
      import('../connection'),
      import('./queues'),
      import('./maintenance-standby'),
    ])

    getActiveSources = sources.getActiveSources
    getServingSourceNames = sources.getServingSourceNames
    EXPECTED_METRICS = expectedMetrics.EXPECTED_METRICS
    EXPECTED_METRICS_BY_SOURCE = expectedMetrics.EXPECTED_METRICS_BY_SOURCE
    getIngestPool = database.getIngestPool
    getConnection = connection.getConnection
    fastLaneEnabled = queues.fastLaneEnabled
    getFastQueue = queues.getFastQueue
    getIngestQueue = queues.getIngestQueue
    getRegionQueue = queues.getRegionQueue
    INGEST_JOB = queues.INGEST_JOB
    INGEST_REGIONS = queues.INGEST_REGIONS
    isFastTierA = queues.isFastTierA
    regionFastQueueName = queues.regionFastQueueName
    regionQueueName = queues.regionQueueName

    // Maintenance jobs are framework-level, not per-source. Cadences and
    // primary/standby placement live in ./maintenance-standby.
    STATIC_SCHEDULERS = standby.MAINTENANCE_SCHEDULES.map((job) => ({ ...job }))
    MAINTENANCE_STANDBY_REGIONS = standby.MAINTENANCE_STANDBY_REGIONS
    SOURCE_SCOPED_JOBS = new Set<string>([
      INGEST_JOB.TIER_A,
      INGEST_JOB.TIER_B,
      INGEST_JOB.TIER_B_SERIES,
      INGEST_JOB.TIER_D,
      INGEST_JOB.DERIVE_BOARDS,
    ])
    GLOBAL_MAINTENANCE_JOBS = new Set<string>(STATIC_SCHEDULERS.map((job) => job.name))
  })()

  return schedulerRuntimeLoad
}

/**
 * Tier priority by scheduler-key prefix — MUST mirror the opts.priority each
 * registration below passes. The revive path derives priority from here
 * (take-7): stored templates can't be trusted (pre-take-6 rebuilds stripped
 * them, and upsertJobScheduler with unchanged `every` never refreshes a
 * template), and a missing priority puts iterations in the prio-0 `wait` lane
 * — ahead of EVERYTHING, inverting the whole tier design.
 */
/**
 * Revive-kick priority (2026-11 audit P2-13): a kick at the SAME priority as
 * its tier queues behind every sibling iteration of that tier, so a revived
 * (already overdue) source waits a full backlog again. One notch higher puts
 * it ahead of its own tier while never jumping past the next tier up (ties at
 * most). Priority 1 is BullMQ's highest prioritized value — 0 would mean the
 * unprioritized `wait` lane, which runs before everything (take-7 inversion),
 * so Tier-A kicks stay at 1.
 */
export function revivePriority(tierPriority: number): number {
  return Math.max(1, tierPriority - 1)
}

const PRIORITY_BY_PREFIX: Record<string, number> = {
  tiera: 1,
  derive: 2,
  tierd: 3,
  fp: 4, // first-party sync (claimed traders — user-facing freshness)
  tierb: 6,
  tierbs: 9,
}

type PendingJobIdentity = {
  id?: string
  name: string
  data: unknown
  timestamp?: number
  repeatJobKey?: string
}

/**
 * A pending iteration owned by a BullMQ job scheduler. BullMQ only creates
 * the NEXT iteration when this one is picked up, so deleting it breaks the
 * repeat chain until the hourly revive notices (2026-11 audit P2-1). These
 * are never dedup candidates.
 */
function isSchedulerIteration(job: PendingJobIdentity): boolean {
  return (
    (typeof job.repeatJobKey === 'string' && job.repeatJobKey.length > 0) ||
    (typeof job.id === 'string' && job.id.startsWith('repeat:'))
  )
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Return the logical identity used by the destructive orphan cleanup pass.
 * Unknown or malformed jobs deliberately have no identity: keeping an extra
 * pending job is safer than deleting work that belongs to another account.
 */
function orphanDedupKey(job: PendingJobIdentity): string | null {
  if (isSchedulerIteration(job)) return null
  const data = job.data && typeof job.data === 'object' ? (job.data as Record<string, unknown>) : {}

  if (job.name === INGEST_JOB.FIRST_PARTY) {
    const authorizationId = nonEmptyString(data.authorizationId)
    return authorizationId ? `${job.name}:authorizationId:${authorizationId}` : null
  }

  if (SOURCE_SCOPED_JOBS.has(job.name)) {
    const sourceSlug = nonEmptyString(data.sourceSlug)
    return sourceSlug ? `${job.name}:sourceSlug:${sourceSlug}` : null
  }

  if (GLOBAL_MAINTENANCE_JOBS.has(job.name)) return `${job.name}:global`
  return null
}

function comparePendingJobs(a: PendingJobIdentity, b: PendingJobIdentity): number {
  const timestampDelta = (a.timestamp ?? 0) - (b.timestamp ?? 0)
  if (timestampDelta !== 0) return timestampDelta
  // BullMQ ids are unique. The lexical fallback makes equal-timestamp cleanup
  // deterministic instead of retaining every duplicate indefinitely.
  return (a.id ?? '').localeCompare(b.id ?? '')
}

/**
 * Board size used for the Tier-A lane split (2026-11 audit P2-13).
 * `arena.sources.expected_count` is a configured value that goes stale as a
 * board grows; a board configured at 2k that now returns 20k rows would keep
 * monopolising fast-lane slots. Use the larger of the configured count and
 * the largest recently observed PASSED snapshot. Unknown on both sides stays
 * unknown (→ heavy/bulk, see isFastTierA).
 */
export function effectiveTierABoardSize(
  expectedCount: number | null | undefined,
  observedCount: number | null | undefined
): number | null {
  const known = [expectedCount, observedCount].filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  )
  return known.length > 0 ? Math.max(...known) : null
}

/** Largest PASSED snapshot row count per source over the last 7 days. A read
 *  failure is logged and yields an empty map (configured counts only). */
async function observedBoardSizes(): Promise<Map<string, number>> {
  try {
    const { rows } = await getIngestPool().query<{ slug: string; observed: number | string }>(
      `SELECT s.slug, max(ls.actual_count) AS observed
         FROM arena.leaderboard_snapshots ls
         JOIN arena.sources s ON s.id = ls.source_id
        WHERE ls.count_check_passed
          AND ls.scraped_at > now() - interval '7 days'
        GROUP BY s.slug`
    )
    return new Map(rows.map((r) => [r.slug, Number(r.observed)]))
  } catch (err) {
    console.error(
      '[ingest-scheduler] observed board-size read failed; using configured expected_count only:',
      err instanceof Error ? err.message : err
    )
    return new Map()
  }
}

/** Register every scheduler one source owns; throws on the first failure
 *  (the caller isolates it). Keys are added to `wanted` BEFORE their await. */
async function registerSourceSchedulers(
  src: ActiveSources[number],
  wanted: Map<string, string>,
  observedBoardSize: number | undefined
): Promise<void> {
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
  const onFast =
    fastLaneEnabled() && isFastTierA(effectiveTierABoardSize(src.expected_count, observedBoardSize))
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

export async function reconcileSchedulers(): Promise<void> {
  // Do not read the database, resolve BullMQ queues, or mutate persisted
  // schedulers while this V1 ingest path is unpublished.
  if (!isV1IngestExecutionPublished()) {
    console.error('[RETIRED] V1 ingest execution is not published; schedules remain untouched.')
    return
  }

  await loadSchedulerRuntime()
  const sources = await getActiveSources()
  const observedSizes = await observedBoardSizes()
  // scheduler key → the queue NAME it must live on. A Set isn't enough: a
  // source can MOVE between the bulk and fast lanes (board grows past
  // FAST_TIER_A_MAX_COUNT), and the cleanup pass must then remove the stale
  // tiera:<slug> from the OLD queue — but the key is still "wanted", just on a
  // different queue. So cleanup keys off (key, queueName), not key alone.
  const wanted = new Map<string, string>()
  // Per-source isolation (2026-11 audit P2-2): one source's registration
  // error (Redis blip, cadence 0/NULL → `every: 0` rejected, bad region)
  // used to abort the whole reconcile — every later source, stale cleanup,
  // revive, serving mirror and expected_metrics sync were skipped. Failed
  // sources are recorded, alerted, and protected from the destructive
  // cleanup pass below (their existing schedulers are left untouched).
  const failedSources: Array<{ slug: string; phase: number; error: string }> = []

  for (const src of sources) {
    try {
      await registerSourceSchedulers(src, wanted, observedSizes.get(src.slug))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      failedSources.push({ slug: src.slug, phase: src.phase, error })
      console.error(`[ingest-scheduler] scheduler registration failed for ${src.slug}: ${error}`)
    }
  }
  const failedSlugs = new Set(failedSources.map((f) => f.slug))

  // Framework maintenance: PRIMARY on the local node (unchanged id), plus a
  // STANDBY copy per standby region (SG) that only executes when the primary
  // is overdue (see ./maintenance-standby). Without it, the Mac dying took
  // the freshness sentinel, digest and partition pre-creation down with it.
  const localQueue = getIngestQueue()
  for (const s of STATIC_SCHEDULERS) {
    wanted.set(s.id, regionQueueName('local'))
    await localQueue.upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.name, data: {} })
    if (!s.standby) continue
    for (const region of MAINTENANCE_STANDBY_REGIONS) {
      if (!(INGEST_REGIONS as readonly string[]).includes(region)) continue
      const id = `${s.id}:${region}`
      wanted.set(id, regionQueueName(region))
      try {
        await getRegionQueue(region).upsertJobScheduler(
          id,
          { every: s.everyMs },
          { name: s.name, data: { standby: true } }
        )
      } catch (err) {
        console.error(
          `[ingest-scheduler] standby maintenance ${id} registration failed: ` +
            (err instanceof Error ? err.message : String(err))
        )
      }
    }
  }

  // V1 CEX API keys are account connections, not public-profile proof. Do not
  // create authorization-wide FIRST_PARTY schedulers. Any stale `fp:*` entry
  // is absent from `wanted` and the cleanup pass below removes it. The processor
  // independently requires an exact reviewed identity mapping so a queued job
  // from an immutable older deployment also fails closed.

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
      // A source whose registration failed this pass keeps its existing
      // schedulers untouched: no stale-removal, no revive.
      if (failedSlugs.has(key.slice(key.indexOf(':') + 1))) continue
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
        //
        // take-7b (2026-07-09): floor the stuck threshold at 45 min. `2×every`
        // alone scales DOWN with cadence: when series-backfill cadence went
        // 1800s→600s the trigger silently tightened 60min→20min, and a prio-9
        // iteration queued >20min is NORMAL under load — every hourly reconcile
        // (×2 nodes) then "revived" ~20 healthy schedulers ("revived 20 stuck"
        // hourly in SG logs).
        const state = await iterationJob.getState().catch(() => 'unknown')
        if (overdueMs < Math.max(2 * every, 45 * 60_000) || state === 'active') continue
        reason = `iteration stuck in ${state}`
      }
      // take-7b: remove the superseded iteration BEFORE rebuilding. The rebuild
      // (removeJobScheduler + upsertJobScheduler) detaches the old iteration
      // job but leaves it IN the queue — each revive wave stacked one more
      // orphan per source (295 prio-9 zombies by 07-09, oldest 9h; the clog
      // lengthened queue latency, which made more schedulers look stuck, which
      // revived more: the same feedback shape as take-6's kick wedge). Never
      // remove an ACTIVE job (guarded above); remove() on a just-started one
      // throws and is caught — the orphan then drains normally.
      if (iterationJob) {
        try {
          await iterationJob.remove()
        } catch {
          /* just-started or already gone — the orphan then drains normally */
        }
      }
      const tmplData = scheduler.template?.data ?? {}
      // take-6 (2026-07-03): preserve the template OPTS on rebuild. The old
      // rebuild passed only {name, data}, silently dropping opts.priority —
      // every revived scheduler's future iterations ran at default priority.
      //
      // take-7 (2026-07-03, hours later): "preserve template opts" is NOT
      // enough. Schedulers that a pre-take-6 rebuild already stripped carry no
      // priority in their stored template, and upsertJobScheduler with an
      // UNCHANGED `every` never refreshes the template — so the regular
      // reconcile pass passing {priority: 9} can't heal them. Their iterations
      // spawn with priority 0 → the `wait` lane → picked BEFORE every
      // prioritized job: prio-9 series batches were observed running while 89
      // prio-1 tier-A boards starved (worse inversion than the original bug).
      // Fix: priority is DERIVED from the scheduler key's tier prefix (the
      // same values registration uses) — never trusted from the stored
      // template. Template opts win only if the prefix is unknown.
      const tmplOpts = (scheduler.template?.opts ?? {}) as { priority?: number }
      const tierPriority = PRIORITY_BY_PREFIX[key.split(':')[0]] ?? tmplOpts.priority ?? 1
      await q.removeJobScheduler(key)
      await q.upsertJobScheduler(
        key,
        { every },
        { name: scheduler.name, data: tmplData, opts: { ...tmplOpts, priority: tierPriority } }
      )
      // CRITICAL (2026-06-13 take-4): upsertJobScheduler's first iteration only
      // fires after a full `every` interval — for a 5h-cadence Tier-A that means
      // a revived source waits 5h to crawl (bitget×5 sat idle 1.5h post-revival
      // producing zero RAW). Enqueue an immediate one-off so the source crawls
      // NOW; the scheduler then resumes its normal cadence.
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
      //
      // take-6 (2026-07-03): the kick was the wedge engine. Two flaws compounded
      // into a 4.6k-job prioritized clog (oldest 06-16) that starved tier-A/B/D
      // for hours-to-days:
      //   1. Hardcoded priority:1 — a revived tierbs (priority 9 by design,
      //      180s each) kick jumped AHEAD of tier-A boards. 400+ prio-1
      //      tierb:series kicks monopolized the 5 worker slots.
      //   2. Timestamped jobId — every reconcile minted a NEW kick even when
      //      the previous kick was still sitting unprocessed in the queue.
      //      Clogged queue → schedulers look stuck → more kicks → more clog.
      // Fix: inherit the template priority, and use a STABLE jobId so a pending
      // kick dedups (BullMQ ignores add() with an existing jobId; the id frees
      // on completion via removeOnComplete, so the next genuine revive re-kicks).
      try {
        await q.add(scheduler.name, tmplData, {
          priority: revivePriority(tierPriority),
          jobId: `revive-kick-${key.replace(/:/g, '-')}`,
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

  // Orphan-dedup maintenance (2026-07-09, take-7b companion): worker restarts
  // and historical revive waves can leave multiple pending instances of the
  // same logical job in a queue. take-7b stopped NEW orphans at the
  // source (rebuild now removes the superseded iteration); this pass drains
  // whatever legacy/restart debris still accumulates — keep only the NEWEST
  // per proven logical identity. Idempotent-by-design jobs (cursor-driven
  // tierbs, board crawls) lose nothing. Fail-soft: dedup errors never abort
  // the reconcile.
  let deduped = 0
  try {
    // Both lanes: Tier-A on the fast lane accumulates the same restart/kick
    // debris as the bulk queue.
    const lanes = INGEST_REGIONS.flatMap((region) => [
      { q: getRegionQueue(region), queueName: regionQueueName(region) },
      { q: getFastQueue(region), queueName: regionFastQueueName(region) },
    ])
    for (const { q, queueName } of lanes) {
      const jobs = await q.getJobs(['prioritized', 'waiting'], 0, 500)
      const newest = new Map<string, (typeof jobs)[number]>()
      let unscoped = 0
      for (const j of jobs) {
        if (isSchedulerIteration(j)) continue // scheduler-owned: always kept
        const k = orphanDedupKey(j)
        if (!k) {
          unscoped++
          continue
        }
        const current = newest.get(k)
        if (!current || comparePendingJobs(j, current) > 0) newest.set(k, j)
      }
      for (const j of jobs) {
        const k = orphanDedupKey(j)
        if (!k) continue
        const winner = newest.get(k)
        if (winner && comparePendingJobs(j, winner) < 0) {
          try {
            await j.remove()
            deduped++
          } catch {
            /* active/locked — leave it */
          }
        }
      }
      if (unscoped > 0) {
        console.warn(
          `[ingest-scheduler] orphan-dedup kept ${unscoped} unscoped pending jobs ` +
            `in ${queueName}`
        )
      }
    }
  } catch (err) {
    console.warn(
      '[ingest-scheduler] orphan-dedup pass failed (non-fatal):',
      err instanceof Error ? err.message : err
    )
  }

  console.log(
    `[ingest-scheduler] reconciled: ${sources.length} active sources, ` +
      `${wanted.size} schedulers${revived ? `, revived ${revived} stuck` : ''}` +
      `${deduped ? `, deduped ${deduped} orphans` : ''}`
  )

  if (failedSources.length > 0) {
    console.error(
      `[ingest-scheduler] ${failedSources.length}/${sources.length} source(s) failed registration: ` +
        failedSources.map((f) => f.slug).join(', ')
    )
    await alertFailedRegistrations(failedSources)
  }

  await reconcileServingSources()
  await syncExpectedMetrics(sources)
}

/** Best-effort: one digest entry per failed source. Alerting must never
 *  abort the reconcile it reports on. */
async function alertFailedRegistrations(
  failed: Array<{ slug: string; phase: number; error: string }>
): Promise<void> {
  try {
    const { alert } = await import('@/lib/ingest/alerting')
    const redis = getConnection()
    for (const f of failed) {
      await alert(redis, {
        sourceSlug: f.slug,
        phase: f.phase,
        tier: 'maint',
        message: `scheduler registration failed (existing schedulers left untouched): ${f.error.slice(0, 200)}`,
      })
    }
  } catch (err) {
    console.error(
      '[ingest-scheduler] could not alert failed registrations:',
      err instanceof Error ? err.message : err
    )
  }
}

/**
 * Sync each adapter's code-declared expectedMetrics into
 * arena.sources.meta.expected_metrics (P0 of the data-completeness system,
 * 2026-07-04). The fill-rate sentinel reads it as the "should-have" truth —
 * mv_source_capabilities can't serve that role (its metric list is derived
 * from trader_stats counts: measures "have", never "should have").
 * Skips sources whose adapter doesn't declare yet; failures never abort the
 * reconcile (best-effort sync, next hourly run retries).
 */
async function syncExpectedMetrics(sources: ActiveSources): Promise<void> {
  for (const src of sources) {
    try {
      const declared = EXPECTED_METRICS_BY_SOURCE[src.slug] ?? EXPECTED_METRICS[src.adapter_slug]
      if (!declared || declared.length === 0) continue
      const current = src.meta?.expected_metrics
      if (JSON.stringify(current) === JSON.stringify(declared)) continue
      await getIngestPool().query(
        `UPDATE arena.sources
            SET meta = meta || jsonb_build_object('expected_metrics', $2::jsonb)
          WHERE slug = $1`,
        [src.slug, JSON.stringify(declared)]
      )
      console.log(`[ingest-scheduler] synced expected_metrics for ${src.slug} (${declared.length})`)
    } catch (err) {
      console.warn(
        `[ingest-scheduler] expected_metrics sync failed for ${src.slug}:`,
        err instanceof Error ? err.message : err
      )
    }
  }
}

/**
 * Mirror the DB serving set (arena.sources.serving_mode='serving') into the
 * Redis `serving_sources` key the frontend reads. The DB is authoritative;
 * this keeps the hot-path Redis mirror fresh so flipping serving_mode is the
 * ONLY control surface — no hand-editing the Redis list (the past source of
 * drift). Best-effort: a failure here must never abort the scheduler.
 */
export async function reconcileServingSources(): Promise<void> {
  // This mirror writes Redis, so keep it behind the same source publication
  // boundary even when called independently of scheduler reconciliation.
  if (!isV1IngestExecutionPublished()) {
    console.error(
      '[RETIRED] V1 ingest execution is not published; serving-source mirror remains untouched.'
    )
    return
  }

  await loadSchedulerRuntime()
  try {
    const names = await getServingSourceNames()
    if (names.length === 0) {
      // Never blow away the list from an empty/transient read — the frontend
      // would revert every trader to the empty legacy page.
      console.warn('[ingest-scheduler] serving set empty; leaving Redis mirror untouched')
      return
    }
    await getConnection().set('serving_sources', names.join(','))
    console.log(`[ingest-scheduler] serving_sources mirror updated: ${names.length} names`)
  } catch (err) {
    console.error(
      '[ingest-scheduler] serving_sources mirror failed (non-fatal): ' +
        (err instanceof Error ? err.message : String(err))
    )
  }
}
