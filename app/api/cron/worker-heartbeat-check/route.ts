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
  REQUIRED_RELEASE_REGIONS,
  WORKER_HEARTBEAT_DECOMMISSION_MS,
  WORKER_HEARTBEAT_STALE_MS,
} from '@/lib/ingest/worker-release-readiness'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ROSTER_KEY = 'arena:worker:roster'
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
  regions?: string[]
  pid?: number
  node?: string
  sha?: string
  attempt_bound_capture?: boolean
  disk?: number
}

// Worker-checkout filesystem used % at/above which we page. This resolves to
// the macOS Data volume and the SG VPS root volume; 88 gives runway before a
// crashloop from a full disk.
const DISK_WARN_PCT = 88

function parseBeat(raw: unknown): HeartbeatPayload | null {
  if (raw == null) return null
  // Upstash REST may return the value already parsed (object) or as a string.
  const obj = typeof raw === 'string' ? safeJson(raw) : (raw as Record<string, unknown>)
  if (!obj || typeof obj.ts !== 'number') return null
  return obj as unknown as HeartbeatPayload
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return null
  }
}

export const GET = withCron('worker-heartbeat-check', async (_request: NextRequest) => {
  const redis = await getSharedRedis()
  if (!redis) {
    // No Redis = can't verify; report rather than silently pass.
    logger.warn('[worker-heartbeat-check] Redis unavailable — cannot verify worker liveness')
    return { count: 0, nodes: 0, down: [], note: 'redis-unavailable' }
  }

  const roster = (await redis.hgetall(ROSTER_KEY)) as Record<string, unknown> | null
  const now = Date.now()
  const entries = Object.entries(roster ?? {})

  const down: Array<{ node: string; age_min: number; regions: string[] }> = []
  const healthy: string[] = []
  const healthyRegions = new Set<string>()
  const pruned: string[] = []
  const liveShas: Array<{ node: string; sha: string }> = []
  const highDisk: Array<{ node: string; disk: number }> = []

  for (const [node, raw] of entries) {
    const beat = parseBeat(raw)
    if (!beat) {
      // Unparseable entry — prune it so it doesn't linger.
      await redis.hdel(ROSTER_KEY, node)
      pruned.push(node)
      continue
    }
    const age = now - beat.ts
    if (age >= DECOMMISSION_MS) {
      await redis.hdel(ROSTER_KEY, node)
      pruned.push(node)
    } else if (age >= STALE_MS) {
      down.push({ node, age_min: Math.round(age / 60_000), regions: beat.regions ?? [] })
    } else {
      healthy.push(node)
      for (const r of beat.regions ?? []) healthyRegions.add(r)
      if (beat.sha && beat.sha !== 'unknown') liveShas.push({ node, sha: beat.sha })
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

  // Code-drift alarm: live nodes running different commits (the root cause of the
  // SG node silently running 18-day-old ingest code). Alert when ≥2 distinct SHAs.
  const distinctShas = [...new Set(liveShas.map((s) => s.sha))]
  if (distinctShas.length > 1) {
    const lines = liveShas.map((s) => `  ${s.node}: ${s.sha.slice(0, 9)}`)
    await sendRateLimitedAlert(
      {
        title: `Ingest worker code drift: ${distinctShas.length} versions live`,
        message:
          `Worker nodes are running DIFFERENT commits — fixes deployed to one node ` +
          `are missing on the other (stale parsers / guards).\n${lines.join('\n')}\n\n` +
          `Resync the lagging node: bash worker/deploy-ingest-sg.sh`,
        level: 'warning',
        details: { distinctShas, liveShas },
      },
      'worker-heartbeat:drift',
      6 * 3600_000 // 6h cooldown — drift is not urgent, but must not go unseen
    ).catch((err) => logger.warn('[worker-heartbeat-check] drift alert failed:', err))
  }

  logger.info(
    `[worker-heartbeat-check] ${healthy.length} healthy, ${down.length} down, ${pruned.length} pruned, ` +
      `${distinctShas.length} live sha(s)`
  )
  return {
    count: entries.length,
    nodes: entries.length,
    healthy,
    down,
    uncovered: uncovered.length > 0 ? uncovered : undefined,
    pruned: pruned.length > 0 ? pruned : undefined,
  }
})
