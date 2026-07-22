/**
 * Standby failover (de-single-point, P0 failover half).
 *
 * The Mac Mini consumes the `local` queue (~83% of sources). If it dies, those
 * jobs pile up in cloud Redis with no consumer. This lets a SECONDARY worker
 * (e.g. the SG VPS) temporarily take over the `local` queue so crawling
 * continues during the outage — degraded (the secondary's egress IP may be
 * blocked by some IP-sensitive sources) but partial data beats none.
 *
 * Two safety gates, both must hold to activate a failover region R:
 *   1. FLAG-GATED — an operator sets the Redis key `arena:failover:regions`
 *      (comma list, e.g. "local") in response to the heartbeat-down page.
 *      Nothing activates without this, so a healthy cluster never crawls
 *      IP-sensitive sources from the wrong IP by accident.
 *   2. AUTO-STAND-DOWN — even with the flag left set, R only activates while
 *      NO other node natively covers R with a fresh heartbeat. The moment the
 *      Mac's heartbeat returns, the secondary drops `local` again — so a
 *      forgotten flag can't keep burning the secondary's IP after recovery.
 *
 * Reconciled on startup and every 30s. Reuses existing infra (the SG worker +
 * cloud Redis) — no new node to provision.
 */

import { Worker, type Job } from 'bullmq'
import type IORedis from 'ioredis'
import { ingestConnection, regionQueueName, INGEST_REGIONS, type IngestRegion } from './queues'
import { WORKER_ROSTER_KEY, workerNodeId } from './heartbeat'
import { WORKER_FAILOVER_FLAG_KEY } from '@/lib/ingest/worker-release-readiness'

export const FAILOVER_FLAG_KEY = WORKER_FAILOVER_FLAG_KEY
const RECONCILE_MS = 30_000
const FRESH_MS = 5 * 60_000 // a native heartbeat newer than this "covers" its regions

export interface FailoverWorkerOpts {
  concurrency: number
  lockDuration: number
  stalledInterval: number
  maxStalledCount: number
}

/** Regions currently covered by a FRESH heartbeat from some OTHER node. */
async function nativelyCoveredRegions(redis: IORedis, selfNode: string): Promise<Set<string>> {
  const covered = new Set<string>()
  try {
    const roster = await redis.hgetall(WORKER_ROSTER_KEY)
    const now = Date.now()
    for (const [node, raw] of Object.entries(roster ?? {})) {
      if (node === selfNode) continue
      let payload: { ts?: number; regions?: string[] }
      try {
        payload = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof payload.ts !== 'number' || now - payload.ts > FRESH_MS) continue
      for (const r of payload.regions ?? []) covered.add(r)
    }
  } catch (err) {
    // On a roster read error, be conservative: assume everything is covered so
    // we DON'T spin up a failover crawl on a hiccup.
    console.error(
      '[failover] roster read failed, assuming covered:',
      err instanceof Error ? err.message : err
    )
    for (const r of INGEST_REGIONS) covered.add(r)
  }
  return covered
}

/**
 * Start the failover manager. Returns a stop() for graceful shutdown.
 * `nativeRegions` = the regions this worker already consumes natively (it never
 * fails-over to those — it already has them).
 */
export function startFailoverManager(
  redis: IORedis,
  nativeRegions: string[],
  route: (job: Job) => Promise<unknown>,
  opts: FailoverWorkerOpts
): { stop: () => Promise<void> } {
  const selfNode = workerNodeId()
  const native = new Set(nativeRegions)
  const active = new Map<string, Worker>() // region → failover Worker

  const startRegion = (region: string): void => {
    if (active.has(region)) return
    const w = new Worker(regionQueueName(region), route, {
      connection: ingestConnection(),
      concurrency: opts.concurrency,
      lockDuration: opts.lockDuration,
      stalledInterval: opts.stalledInterval,
      maxStalledCount: opts.maxStalledCount,
    })
    w.on('completed', (job) => console.log(`[failover] ✓ ${job.name} (${job.id}) [${region}*]`))
    w.on('failed', (job, err) =>
      console.error(`[failover] ✗ ${job?.name} (${job?.id}) [${region}*]:`, err.message)
    )
    active.set(region, w)
    console.warn(`[failover] ACTIVATED — now consuming ${region} (primary appears down)`)
  }

  const stopRegion = async (region: string): Promise<void> => {
    const w = active.get(region)
    if (!w) return
    active.delete(region)
    await w.close()
    console.warn(
      `[failover] STOOD DOWN — stopped consuming ${region} (primary recovered or flag cleared)`
    )
  }

  const reconcile = async (): Promise<void> => {
    try {
      const raw = (await redis.get(FAILOVER_FLAG_KEY)) ?? ''
      const flagged = new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((r): r is IngestRegion => (INGEST_REGIONS as readonly string[]).includes(r))
          .filter((r) => !native.has(r)) // never "fail-over" to a region we already own
      )

      const covered =
        flagged.size > 0 ? await nativelyCoveredRegions(redis, selfNode) : new Set<string>()

      // A region should run iff it's flagged AND not currently covered by a
      // fresh native heartbeat from another node.
      const wanted = new Set([...flagged].filter((r) => !covered.has(r)))

      for (const region of wanted) startRegion(region)
      for (const region of [...active.keys()]) {
        if (!wanted.has(region)) await stopRegion(region)
      }
    } catch (err) {
      console.error('[failover] reconcile failed:', err instanceof Error ? err.message : err)
    }
  }

  void reconcile()
  const timer = setInterval(() => void reconcile(), RECONCILE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  console.log(
    `[failover] manager started (native=${nativeRegions.join(',')}, flag=${FAILOVER_FLAG_KEY})`
  )

  return {
    stop: async () => {
      clearInterval(timer)
      await Promise.all([...active.values()].map((w) => w.close()))
      active.clear()
    },
  }
}
