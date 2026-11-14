/**
 * Liveness heartbeat for the scoring process (`arena-worker`).
 *
 * WHY (2026-11 audit P1-3): only the ingest worker wrote the shared roster
 * heartbeat, so "crawling fine, scoring process dead" was invisible — and the
 * scoring process is the only writer of the public leaderboard. It now uses
 * the exact same mechanism as the ingest worker (startHeartbeat: HSET into
 * `arena:worker:roster` every 60s on the shared cloud Redis, first write
 * awaited before ready) under its own roster field and the `scoring`
 * pseudo-region, which the ingest release/topology invariants ignore and
 * worker-heartbeat-check reports separately.
 */

import type IORedis from 'ioredis'
import { SCORING_HEARTBEAT_REGION } from '@/lib/ingest/worker-heartbeat-topology'
import { resolveWorkerRuntimeIdentity, startHeartbeat, workerNodeId } from './ingest/heartbeat'

/** Distinct roster field: the scoring process may share a host (and its
 *  WORKER_NODE_ID) with an ingest worker, whose field it must never overwrite. */
export function scoringHeartbeatNodeId(): string {
  return process.env.SCORING_WORKER_NODE_ID || `scoring@${workerNodeId()}`
}

export async function startScoringHeartbeat(
  redis: IORedis,
  start: typeof startHeartbeat = startHeartbeat
): Promise<NodeJS.Timeout> {
  return start(redis, [SCORING_HEARTBEAT_REGION], {
    ...resolveWorkerRuntimeIdentity(),
    // Scoring never runs attempt-bound ingest capture.
    attempt_bound_capture: false,
    node: scoringHeartbeatNodeId(),
  })
}
