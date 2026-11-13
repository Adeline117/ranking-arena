/**
 * GET /api/cron/worker-heartbeat-check
 *
 * De-single-point P0 detection: the ingest workers run off-Vercel (Mac Mini
 * for `local`, SG VPS for `vps_sg`). The Mac handles ~83% of sources, so its
 * death silently stops most crawling. Data-freshness alarms can't catch this
 * fast (Tier-A cadence is 5-6h, so "dead" looks like "normal cadence" for
 * >12h), and the on-Mac OpenClaw monitor dies with the Mac.
 *
 * Each worker writes a liveness timestamp every 60s into the shared cloud
 * Redis hash `arena:worker:roster` (Upstash — survives the node dying). This
 * cron runs on Vercel (independent of every worker node) every 15min and pages
 * when a node's heartbeat is stale. Detection latency ~15min, decoupled from
 * crawl cadence.
 *
 * Self-configuring: the roster is discovered from the hash itself. A node gone
 * longer than DECOMMISSION_MS is treated as intentionally removed and pruned
 * (so a retired node doesn't page forever); between STALE_MS and
 * DECOMMISSION_MS it pages.
 */

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { getSharedRedis } from '@/lib/cache/redis-client'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import {
  evaluateWorkerHeartbeatTopology,
  SCORING_HEARTBEAT_REGION,
} from '@/lib/ingest/worker-heartbeat-topology'
import {
  REQUIRED_RELEASE_REGIONS,
  summarizeWorkerRuntimeDrift,
  WORKER_HEARTBEAT_DECOMMISSION_MS,
  WORKER_HEARTBEAT_STALE_MS,
} from '@/lib/ingest/worker-release-readiness'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ROSTER_KEY = 'arena:worker:roster'
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const STALE_MS = WORKER_HEARTBEAT_STALE_MS // heartbeat older than this → node is down
const DECOMMISSION_MS = WORKER_HEARTBEAT_DECOMMISSION_MS // older → assume retired, prune

/**
 * Regions that MUST have a fresh consumer for crawling to function — the
 * true invariant (2026-07-05 postmortem). Per-node down alerts alone failed
 * us twice in one incident:
 *   1. A zombie identity ("vultr", a long-dead host-level process on the SG
 *      box) kept the DOWN alert firing for days → alert fatigue → when the
 *      real SG container crash-looped for 27h, its alert looked like the
 *      same background noise.
 *   2. After DECOMMISSION_MS the dead node is pruned and the alert stops
 *      FOREVER — a permanently-dead region goes permanently silent.
 * Region coverage is roster-independent: it pages as long as the region has
 * no healthy consumer, no matter which node identities come and go.
 * vps_jp intentionally absent (aspirational region, no sources pinned yet).
 */
const REQUIRED_REGIONS: readonly string[] = REQUIRED_RELEASE_REGIONS

interface HeartbeatPayload {
  ts: number
  regions: string[]
  pid?: number
  node?: string
  sha?: string
  release_id?: string
  attempt_bound_capture?: boolean
  disk?: number
}

// Worker-checkout filesystem used % at/above which we page. This resolves to
// the macOS Data volume and the SG VPS root volume; 88 gives runway before a
// crashloop from a full disk.
const DISK_WARN_PCT = 88

function parseBeat(raw: unknown): HeartbeatPayload | null {
  // Upstash REST may return the value already parsed (object) or as a string.
  const obj = typeof raw === 'string' ? safeJson(raw) : raw
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const beat = obj as Record<string, unknown>
  if (!Number.isSafeInteger(beat.ts) || Number(beat.ts) <= 0) return null
  if (
    !Array.isArray(beat.regions) ||
    beat.regions.length === 0 ||
    beat.regions.some(
      (region) =>
        typeof region !== 'string' ||
        region.length === 0 ||
        region.length > 80 ||
        region.trim() !== region
    )
  ) {
    return null
  }
  return {
    ...beat,
    regions: [...new Set(beat.regions as string[])],
    ts: Number(beat.ts),
  } as HeartbeatPayload
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(s)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const GET = withCron(
  'worker-heartbeat-check',
  async (_request: NextRequest) => {
    // No Redis (unconfigured, client error, or roster read failure) = the
    // dead-man's switch is blind. Page and fail the run instead of the old
    // `{count:0}` success (audit P2-4): "cannot see the workers" must never
    // look like "workers fine".
    let redis: Awaited<ReturnType<typeof getSharedRedis>> = null
    let roster: Record<string, unknown> | null = null
    let blindReason: string | null = null
    try {
      redis = await getSharedRedis()
      if (!redis) blindReason = 'Redis client unavailable'
      else roster = (await redis.hgetall(ROSTER_KEY)) as Record<string, unknown> | null
    } catch (err) {
      blindReason = `roster read failed: ${err instanceof Error ? err.message : String(err)}`
    }
    if (!redis || blindReason) {
      logger.error(`[worker-heartbeat-check] cannot verify worker liveness — ${blindReason}`)
      await sendRateLimitedAlert(
        {
          title: 'Worker heartbeat check BLIND (Redis unavailable)',
          message:
            `worker-heartbeat-check cannot read the shared heartbeat roster (${ROSTER_KEY}). ` +
            `Ingest/scoring worker liveness is UNVERIFIED until Redis is reachable again.`,
          level: 'critical',
          details: { reason: blindReason },
        },
        'worker-heartbeat:blind',
        60 * 60_000
      ).catch((err) => logger.warn('[worker-heartbeat-check] blind alert failed:', err))
      throw new Error(`worker-heartbeat-check blind: ${blindReason}`)
    }
    const now = Date.now()
    const entries = Object.entries(roster ?? {})
    const topology = evaluateWorkerHeartbeatTopology(roster, now)

    const down: Array<{ node: string; age_min: number; regions: string[] }> = []
    const healthy: string[] = []
    const healthyRegions = new Set<string>()
    const pruned: string[] = []
    const liveReleases: Array<{ node: string; release_id: string; sha: string }> = []
    const highDisk: Array<{ node: string; disk: number }> = []
    // Scoring process (arena-worker) beats share the roster but are not ingest
    // nodes: tracked separately so they neither count as crawl coverage nor
    // trip the ingest runtime-drift alarm.
    const scoringHealthy: string[] = []
    const scoringDown: Array<{ node: string; age_min: number }> = []

    for (const [node, raw] of entries) {
      const beat = parseBeat(raw)
      if (!beat) {
        // Unparseable entry — prune it so it doesn't linger.
        await redis.hdel(ROSTER_KEY, node)
        pruned.push(node)
        continue
      }
      const age = now - beat.ts
      const scoringOnly = beat.regions.every((r) => r === SCORING_HEARTBEAT_REGION)
      if (age >= DECOMMISSION_MS) {
        await redis.hdel(ROSTER_KEY, node)
        pruned.push(node)
      } else if (scoringOnly) {
        if (age >= STALE_MS) scoringDown.push({ node, age_min: Math.round(age / 60_000) })
        else scoringHealthy.push(node)
      } else if (age >= STALE_MS) {
        down.push({ node, age_min: Math.round(age / 60_000), regions: beat.regions ?? [] })
      } else {
        healthy.push(node)
        for (const r of beat.regions) healthyRegions.add(r)
        liveReleases.push({
          node,
          release_id:
            typeof beat.release_id === 'string' && RELEASE_ID.test(beat.release_id)
              ? beat.release_id
              : 'unknown',
          sha: typeof beat.sha === 'string' && COMMIT_SHA.test(beat.sha) ? beat.sha : 'unknown',
        })
        if (typeof beat.disk === 'number' && beat.disk >= DISK_WARN_PCT) {
          highDisk.push({ node, disk: beat.disk })
        }
      }
    }

    // Disk-fill early warning — a full disk on the SG VPS silently crashloops the
    // container (docker can't write). Older workers omit `disk`; absent = no page.
    if (highDisk.length > 0) {
      await sendRateLimitedAlert(
        {
          title: `Ingest worker DISK high: ${highDisk.map((d) => `${d.node} ${d.disk}%`).join(', ')}`,
          message:
            `Worker node disk ≥ ${DISK_WARN_PCT}% — a full disk crashloops the container.\n` +
            highDisk.map((d) => `⚠️ ${d.node}: ${d.disk}% used`).join('\n') +
            `\n\nFree space: on the box \`docker system prune -f\` (keep npm-ci cache) / clear old logs; ` +
            `SG VPS = root@45.76.152.169 (/opt/arena-ingest).`,
          level: 'warning',
          details: { highDisk },
        },
        'worker-heartbeat:disk',
        6 * 3600_000 // 6h cooldown — disk fills slowly
      ).catch((err) => logger.warn('[worker-heartbeat-check] disk alert failed:', err))
    }

    // Region-coverage invariant — pages regardless of roster state (see
    // REQUIRED_REGIONS). Fires every run while uncovered (15min cooldown),
    // unlike the per-node alert which dies with the pruned identity.
    const uncovered = REQUIRED_REGIONS.filter((r) => !healthyRegions.has(r))
    if (uncovered.length > 0) {
      await sendRateLimitedAlert(
        {
          title: `Ingest REGION uncovered: ${uncovered.join(', ')}`,
          message:
            `No healthy worker is consuming region(s) ${uncovered.join(', ')} — ` +
            `ALL crawling for their sources is stalled (node crashed, crash-looping, ` +
            `or pruned after 24h down).\n` +
            `Healthy nodes: ${healthy.join(', ') || 'none'}\n` +
            `Check: docker ps + docker logs on the region's box; ` +
            `worker/deploy-ingest-sg.sh for vps_sg; pm2 for local.`,
          level: 'critical',
          details: { uncovered, healthy, healthyRegions: [...healthyRegions] },
        },
        'worker-heartbeat:region-uncovered',
        15 * 60_000
      ).catch((err) => logger.warn('[worker-heartbeat-check] region alert failed:', err))
    }

    if (down.length > 0) {
      const lines = down.map(
        (d) =>
          `🔴 ${d.node} (regions: ${d.regions.join(',') || '?'}) — no heartbeat for ${d.age_min}min`
      )
      // The regions that just lost their only consumer — what a standby worker
      // should fail over to. (Dedup across downed nodes.)
      const downRegions = [...new Set(down.flatMap((d) => d.regions))].filter(Boolean)
      const failoverHint =
        downRegions.length > 0
          ? `\n\nFailover (standby worker takes over from cloud Redis):\n` +
            `  redis SET arena:failover:regions "${downRegions.join(',')}"\n` +
            `Auto-stands-down when the primary's heartbeat returns; clear the key after recovery.`
          : ''
      await sendRateLimitedAlert(
        {
          title: `Ingest worker DOWN: ${down.map((d) => d.node).join(', ')}`,
          message:
            `${down.length} worker node(s) stopped heart-beating — crawling for their ` +
            `regions has stalled.\n${lines.join('\n')}\n\nHealthy: ${healthy.join(', ') || 'none'}` +
            failoverHint,
          level: 'critical',
          details: { down, healthy, downRegions },
        },
        'worker-heartbeat:down',
        15 * 60_000 // 15min cooldown — matches cron cadence
      ).catch((err) => logger.warn('[worker-heartbeat-check] alert failed:', err))
    }

    // Scoring liveness: the scoring process is the only writer of the public
    // leaderboard, so "no fresh scoring heartbeat" pages even while every
    // crawler is healthy. Roster-independent like region coverage: it keeps
    // paging after a dead scoring node is pruned.
    if (scoringHealthy.length === 0) {
      await sendRateLimitedAlert(
        {
          title: 'Scoring worker (arena-worker) DOWN',
          message:
            `No fresh heartbeat from the scoring process — leaderboards are not being ` +
            `recomputed or published.\n` +
            (scoringDown.length > 0
              ? scoringDown.map((d) => `🔴 ${d.node} — no heartbeat for ${d.age_min}min`).join('\n')
              : 'No scoring heartbeat in the roster at all.'),
          level: 'critical',
          details: { scoringDown },
        },
        'worker-heartbeat:scoring',
        15 * 60_000
      ).catch((err) => logger.warn('[worker-heartbeat-check] scoring alert failed:', err))
    }

    // Continuous fleet topology invariant. Candidate-release readiness protects
    // deployments; this independent cron catches a duplicate/combined owner or
    // disabled capture that appears later while the fleet is already running.
    if (!topology.ready) {
      const evidence = [
        topology.missing_regions.length > 0
          ? `missing=${topology.missing_regions.join(',')}`
          : null,
        topology.duplicate_regions.length > 0
          ? `duplicate=${topology.duplicate_regions.join(',')}`
          : null,
        topology.combined_owner_nodes.length > 0
          ? `combined=${topology.combined_owner_nodes.join(',')}`
          : null,
        topology.invalid_release_nodes.length > 0
          ? `unknown_release=${topology.invalid_release_nodes.join(',')}`
          : null,
        topology.capture_disabled_nodes.length > 0
          ? `capture_disabled=${topology.capture_disabled_nodes.join(',')}`
          : null,
        topology.distinct_release_ids.length > 1
          ? `release_drift=${topology.distinct_release_ids.length}`
          : null,
        topology.invalid_nodes.length > 0
          ? `malformed=${topology.invalid_nodes.map(({ node, reason }) => `${node}:${reason}`).join(',')}`
          : null,
      ].filter((item): item is string => item !== null)

      await sendRateLimitedAlert(
        {
          title: 'Ingest worker topology INVALID',
          message:
            `Required regions must each have exactly one distinct owner on one valid worker ` +
            `release with attempt-bound capture enabled.\n${evidence.join('\n')}`,
          level: 'critical',
          details: { topology },
        },
        'worker-heartbeat:topology',
        15 * 60_000
      ).catch((err) => logger.warn('[worker-heartbeat-check] topology alert failed:', err))
    }

    // Runtime-drift alarm: compare the deterministic worker bundle rather than
    // monorepo commits. App-only commits may legitimately leave two audit SHAs
    // while the actual worker code and dependencies remain identical.
    const runtimeDrift = summarizeWorkerRuntimeDrift(liveReleases)
    if (runtimeDrift.drift && topology.ready) {
      const lines = liveReleases.map(
        (release) =>
          `  ${release.node}: release=${release.release_id.slice(0, 12)} sha=${release.sha.slice(0, 9)}`
      )
      await sendRateLimitedAlert(
        {
          title:
            runtimeDrift.invalid_nodes.length > 0
              ? `Ingest worker runtime identity invalid: ${runtimeDrift.invalid_nodes.join(', ')}`
              : `Ingest worker runtime drift: ${runtimeDrift.distinct_release_ids.length} releases live`,
          message:
            `Worker nodes have missing/invalid release identity or are running DIFFERENT runtime ` +
            `bundles — fixes deployed to one node may be missing on the other.\n${lines.join('\n')}\n\n` +
            `Resync the lagging node: bash worker/deploy-ingest-sg.sh`,
          level: 'warning',
          details: { runtimeDrift, liveReleases },
        },
        'worker-heartbeat:drift',
        6 * 3600_000 // 6h cooldown — drift is not urgent, but must not go unseen
      ).catch((err) => logger.warn('[worker-heartbeat-check] drift alert failed:', err))
    }

    logger.info(
      `[worker-heartbeat-check] ${healthy.length} healthy, ${down.length} down, ${pruned.length} pruned, ` +
        `${runtimeDrift.distinct_release_ids.length} valid live worker release(s)`
    )
    return {
      count: entries.length,
      nodes: entries.length,
      healthy,
      down,
      uncovered: uncovered.length > 0 ? uncovered : undefined,
      pruned: pruned.length > 0 ? pruned : undefined,
      topology,
      scoring: { healthy: scoringHealthy, down: scoringDown },
    }
  },
  { maxDurationSec: maxDuration }
)
