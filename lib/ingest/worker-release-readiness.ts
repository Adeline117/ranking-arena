export const WORKER_RELEASE_READINESS_CONTRACT = 'arena.worker-release-readiness@2'
export const REQUIRED_RELEASE_REGIONS = ['local', 'vps_sg'] as const
export const WORKER_HEARTBEAT_STALE_MS = 5 * 60_000
export const WORKER_HEARTBEAT_DECOMMISSION_MS = 24 * 3600_000
export const WORKER_FAILOVER_FLAG_KEY = 'arena:failover:regions'

const CLOCK_SKEW_TOLERANCE_MS = 60_000
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const REQUIRED_RELEASE_REGION_SET = new Set<string>(REQUIRED_RELEASE_REGIONS)

interface WorkerBeat {
  ts: number
  regions?: unknown
  sha?: unknown
  release_id?: unknown
  attempt_bound_capture?: unknown
}

export interface ReleaseWorker {
  age_seconds: number
  attempt_bound_capture: boolean
  node: string
  release_id: string
  regions: string[]
  sha: string
}

export interface WorkerReleaseReadiness {
  contract: typeof WORKER_RELEASE_READINESS_CONTRACT
  expected_release_id: string
  expected_sha: string
  failover_regions: string[]
  healthy_workers: ReleaseWorker[]
  invalid_nodes: string[]
  missing_regions: string[]
  ready: boolean
  required_regions: string[]
  stale_workers: ReleaseWorker[]
}

export interface WorkerRuntimeReleaseEvidence {
  node: string
  release_id: string
  sha: string
}

export interface WorkerRuntimeDriftSummary {
  distinct_release_ids: string[]
  invalid_nodes: string[]
  drift: boolean
}

/**
 * Summarize the cron's fresh-worker runtime evidence. Unknown/malformed release
 * identities are themselves drift: two legacy workers reporting the same
 * `unknown` value must page instead of looking converged.
 */
export function summarizeWorkerRuntimeDrift(
  workers: readonly WorkerRuntimeReleaseEvidence[]
): WorkerRuntimeDriftSummary {
  const distinctReleaseIds = [
    ...new Set(
      workers.map((worker) => worker.release_id).filter((releaseId) => RELEASE_ID.test(releaseId))
    ),
  ].sort()
  const invalidNodes = workers
    .filter((worker) => !RELEASE_ID.test(worker.release_id))
    .map((worker) => worker.node)
    .sort()

  return {
    distinct_release_ids: distinctReleaseIds,
    invalid_nodes: invalidNodes,
    drift: invalidNodes.length > 0 || distinctReleaseIds.length > 1,
  }
}

function parseBeat(raw: unknown): WorkerBeat | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const beat = value as Record<string, unknown>
    if (!Number.isSafeInteger(beat.ts) || Number(beat.ts) <= 0) return null
    return {
      ts: Number(beat.ts),
      regions: beat.regions,
      sha: beat.sha,
      release_id: beat.release_id,
      attempt_bound_capture: beat.attempt_bound_capture,
    }
  } catch {
    return null
  }
}

function parseRegions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (
    value.some(
      (region) =>
        typeof region !== 'string' ||
        region.length === 0 ||
        region.trim() !== region ||
        region.length > 80
    )
  ) {
    return null
  }
  return [...new Set(value as string[])].sort()
}

function parseFailoverRegions(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return []
  if (typeof value !== 'string') return ['(invalid)']
  const regions = value.split(',').map((region) => region.trim())
  if (regions.some((region) => region.length === 0 || region.length > 80)) return ['(invalid)']
  return [...new Set(regions)].sort()
}

/**
 * Evaluate the live Redis worker roster against one deterministic worker
 * source/deployment release ID. Git SHA remains audit evidence, but it is deliberately not the
 * compatibility key: an app-only commit must not force an unchanged worker
 * fleet to restart. The release ID is derived from the actual worker runtime
 * inputs and therefore changes whenever reviewed worker code or dependency
 * declarations change. Runtime artifact digests are attested separately.
 */
export function evaluateWorkerReleaseReadiness(
  roster: Record<string, unknown> | null,
  expectedSha: string,
  expectedReleaseId: string,
  now = Date.now(),
  failoverFlag: unknown = null
): WorkerReleaseReadiness {
  if (!COMMIT_SHA.test(expectedSha)) throw new Error('expected worker SHA is invalid')
  if (!RELEASE_ID.test(expectedReleaseId)) throw new Error('expected worker release ID is invalid')

  const healthyWorkers: ReleaseWorker[] = []
  const staleWorkers: ReleaseWorker[] = []
  const invalidNodes: string[] = []

  for (const [rawNode, rawBeat] of Object.entries(roster ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const node = rawNode.trim()
    const beat = parseBeat(rawBeat)
    if (!node || node !== rawNode || node.length > 160 || !beat) {
      invalidNodes.push(node || '(empty)')
      continue
    }

    const ageMs = now - beat.ts
    if (ageMs >= WORKER_HEARTBEAT_DECOMMISSION_MS) continue
    if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
      invalidNodes.push(node)
      continue
    }

    const regions = parseRegions(beat.regions)
    if (!regions) {
      invalidNodes.push(node)
      continue
    }
    if (!regions.some((region) => REQUIRED_RELEASE_REGION_SET.has(region))) continue

    const worker: ReleaseWorker = {
      age_seconds: Math.max(0, Math.floor(ageMs / 1000)),
      attempt_bound_capture: beat.attempt_bound_capture === true,
      node,
      release_id:
        typeof beat.release_id === 'string' && RELEASE_ID.test(beat.release_id)
          ? beat.release_id
          : 'unknown',
      regions,
      sha: typeof beat.sha === 'string' && COMMIT_SHA.test(beat.sha) ? beat.sha : 'unknown',
    }
    if (ageMs >= WORKER_HEARTBEAT_STALE_MS) staleWorkers.push(worker)
    else healthyWorkers.push(worker)
  }

  const missingRegions = REQUIRED_RELEASE_REGIONS.filter(
    (region) =>
      !healthyWorkers.some(
        (worker) => worker.release_id === expectedReleaseId && worker.regions.includes(region)
      )
  )
  const mismatchedWorkerExists = healthyWorkers.some(
    (worker) => worker.release_id !== expectedReleaseId
  )
  const disabledCaptureExists = healthyWorkers.some((worker) => !worker.attempt_bound_capture)
  const failoverRegions = parseFailoverRegions(failoverFlag)
  const exactOwners = REQUIRED_RELEASE_REGIONS.map((region) =>
    healthyWorkers.filter(
      (worker) => worker.release_id === expectedReleaseId && worker.regions.includes(region)
    )
  )
  const uniqueOwnerNodes = new Set(exactOwners.flat().map((worker) => worker.node))
  const topologyIsExact =
    exactOwners.every((owners) => owners.length === 1) &&
    uniqueOwnerNodes.size === REQUIRED_RELEASE_REGIONS.length

  return {
    contract: WORKER_RELEASE_READINESS_CONTRACT,
    expected_release_id: expectedReleaseId,
    expected_sha: expectedSha,
    failover_regions: failoverRegions,
    healthy_workers: healthyWorkers,
    invalid_nodes: [...new Set(invalidNodes)].sort(),
    missing_regions: missingRegions,
    ready:
      missingRegions.length === 0 &&
      invalidNodes.length === 0 &&
      staleWorkers.length === 0 &&
      failoverRegions.length === 0 &&
      !mismatchedWorkerExists &&
      !disabledCaptureExists &&
      topologyIsExact,
    required_regions: [...REQUIRED_RELEASE_REGIONS],
    stale_workers: staleWorkers,
  }
}
