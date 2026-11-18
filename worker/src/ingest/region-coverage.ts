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
import { evaluateWorkerProgress, WORKER_PROGRESS_KEYS } from '@/lib/ingest/worker-progress'
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

/**
 * Scoring-process page. Like region coverage, the only check for a dead or
 * wedged scoring process (arena-worker) lived in the unscheduled Vercel
 * worker-heartbeat-check cron: a failed scoring job alerts on its own, but a
 * process that is down, or alive and publishing nothing, is silent. The
 * ingest sentinel therefore watches it through the shared roster and the
 * scoring output watermark (lib/ingest/worker-progress.ts).
 */
export async function alertScoringSilence(
  redis: IORedis,
  now = Date.now(),
  send: typeof defaultAlert = defaultAlert
): Promise<{ down: boolean; stalled: string[] }> {
  const roster = (await redis.hgetall(WORKER_ROSTER_KEY)) as Record<string, unknown>
  const scoringNodes = evaluateWorkerHeartbeatTopology(roster, now).scoring_nodes
  if (scoringNodes.length === 0) {
    await send(redis, {
      sourceSlug: 'framework:scoring-down',
      phase: 0,
      tier: 'A',
      message:
        'no fresh heartbeat from the scoring process (arena-worker) — leaderboards are not ' +
        'being recomputed or published.',
    })
    return { down: true, stalled: [] }
  }
  const [started, scoring] = await Promise.all([
    redis.hgetall(WORKER_PROGRESS_KEYS.started),
    redis.hgetall(WORKER_PROGRESS_KEYS.scoring),
  ])
  const { stalled } = evaluateWorkerProgress({
    ingestNodes: [],
    scoringNodes,
    started,
    tierA: null,
    scoring,
    now,
  })
  for (const item of stalled) {
    await send(redis, {
      sourceSlug: `framework:scoring-stalled:${item.node}`,
      phase: 0,
      tier: 'A',
      message:
        `scoring process ${item.node} is alive but has not published for ` +
        `${item.stalled_minutes}min (last success ${item.last_success_at ?? 'never since start'}).`,
    })
  }
  return { down: false, stalled: stalled.map((item) => item.node) }
}
