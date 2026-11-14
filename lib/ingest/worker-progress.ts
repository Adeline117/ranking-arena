/**
 * Output watermarks next to the liveness heartbeat (2026-11 audit P2-8).
 *
 * A heartbeat proves the process is alive, not that it produces anything:
 * during the take-6/7 queue wedges every heartbeat stayed green while no
 * board was published for hours. Each worker therefore also records, in
 * companion Redis hashes keyed by the same roster node id:
 *   - `started`: process start (grace baseline after a restart)
 *   - `tier_a`:  last successful (count-check PASSED) Tier-A publication
 *   - `scoring`: last successful leaderboard compute/publication (arena-worker)
 * The roster payload itself is untouched (deploy proofs require exact keys).
 * worker-heartbeat-check pages when a live node's watermark is older than
 * its threshold.
 */

export const WORKER_PROGRESS_KEYS = {
  started: 'arena:worker:progress:started',
  tier_a: 'arena:worker:progress:tier_a',
  scoring: 'arena:worker:progress:scoring',
} as const

export type WorkerProgressKind = 'tier_a' | 'scoring'

/** Tier-A cadence is 5-6h per source → 12h with no publication from a live
 *  ingest node is a stall. Scoring runs every 2h → 6h. */
export const WORKER_PROGRESS_STALE_MS: Record<WorkerProgressKind, number> = {
  tier_a: 12 * 3600_000,
  scoring: 6 * 3600_000,
}

export interface StalledWorker {
  node: string
  kind: WorkerProgressKind
  last_success_at: string | null
  stalled_minutes: number
}

function toMs(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Evaluate live nodes against their watermarks. The baseline is the later of
 * the last success and the process start, so a freshly (re)started worker
 * gets a full threshold of grace. A node with neither marker (an older build
 * that does not write watermarks) is reported as unknown, not stalled.
 */
export function evaluateWorkerProgress(input: {
  ingestNodes: readonly string[]
  scoringNodes: readonly string[]
  started: Record<string, unknown> | null
  tierA: Record<string, unknown> | null
  scoring: Record<string, unknown> | null
  now: number
}): { stalled: StalledWorker[]; unknown: string[] } {
  const stalled: StalledWorker[] = []
  const unknown: string[] = []
  const check = (node: string, kind: WorkerProgressKind, marks: Record<string, unknown> | null) => {
    const last = toMs(marks?.[node])
    const started = toMs(input.started?.[node])
    const baseline = Math.max(last ?? 0, started ?? 0)
    if (baseline === 0) {
      unknown.push(node)
      return
    }
    const age = input.now - baseline
    if (age > WORKER_PROGRESS_STALE_MS[kind]) {
      stalled.push({
        node,
        kind,
        last_success_at: last ? new Date(last).toISOString() : null,
        stalled_minutes: Math.round(age / 60_000),
      })
    }
  }
  for (const node of input.ingestNodes) check(node, 'tier_a', input.tierA)
  for (const node of input.scoringNodes) check(node, 'scoring', input.scoring)
  return { stalled, unknown }
}
