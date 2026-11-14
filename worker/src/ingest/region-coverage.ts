/**
 * Peer region-coverage page (2026-11 audit P1-4).
 *
 * Cross-region failover is disabled, so a dead node's region simply stops
 * crawling. The only coverage alert lived in the Vercel worker-heartbeat-check
 * cron (V1 410, unscheduled). The freshness sentinel runs on the `local`
 * primary and, when that is overdue, on the SG standby
 * (maintenance-standby.ts), so each node watches the other through the shared
 * heartbeat roster: whichever node is alive pages the uncovered region.
 */

import type IORedis from 'ioredis'
import { alert as defaultAlert } from '@/lib/ingest/alerting'
import { evaluateWorkerHeartbeatTopology } from '@/lib/ingest/worker-heartbeat-topology'
import { WORKER_ROSTER_KEY } from './heartbeat'

export async function alertUncoveredRegions(
  redis: IORedis,
  now = Date.now(),
  send: typeof defaultAlert = defaultAlert
): Promise<string[]> {
  const roster = (await redis.hgetall(WORKER_ROSTER_KEY)) as Record<string, unknown>
  const uncovered = evaluateWorkerHeartbeatTopology(roster, now).missing_regions
  for (const region of uncovered) {
    await send(redis, {
      sourceSlug: `framework:region-uncovered:${region}`,
      phase: 0,
      tier: 'A',
      message:
        `no worker with a fresh heartbeat consumes region ${region} — all crawling for its ` +
        'sources is stalled (cross-region failover is disabled; restart that node).',
    })
  }
  return uncovered
}
