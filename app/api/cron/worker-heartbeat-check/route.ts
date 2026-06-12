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

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const ROSTER_KEY = 'arena:worker:roster'
const STALE_MS = 5 * 60_000 // heartbeat older than this → node is down
const DECOMMISSION_MS = 24 * 3600_000 // older than this → assume retired, prune

interface HeartbeatPayload {
  ts: number
  regions?: string[]
  pid?: number
  node?: string
}

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
  const pruned: string[] = []

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
    }
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

  logger.info(
    `[worker-heartbeat-check] ${healthy.length} healthy, ${down.length} down, ${pruned.length} pruned`
  )
  return {
    count: entries.length,
    nodes: entries.length,
    healthy,
    down,
    pruned: pruned.length > 0 ? pruned : undefined,
  }
})
