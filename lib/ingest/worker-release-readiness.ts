export const WORKER_RELEASE_READINESS_CONTRACT = 'arena.worker-release-readiness@1'
export const REQUIRED_RELEASE_REGIONS = ['local', 'vps_sg'] as const
export const WORKER_HEARTBEAT_STALE_MS = 5 * 60_000
export const WORKER_HEARTBEAT_DECOMMISSION_MS = 24 * 3600_000
export const WORKER_FAILOVER_FLAG_KEY = 'arena:failover:regions'

const CLOCK_SKEW_TOLERANCE_MS = 60_000
const COMMIT_SHA = /^[0-9a-f]{40}$/
const REQUIRED_RELEASE_REGION_SET = new Set<string>(REQUIRED_RELEASE_REGIONS)

interface WorkerBeat {
  ts: number
  regions?: unknown
  sha?: unknown
  attempt_bound_capture?: unknown
}

export interface ReleaseWorker {
  age_seconds: number
  attempt_bound_capture: boolean
  node: string
  regions: string[]
  sha: string
}

export interface WorkerReleaseReadiness {
  contract: typeof WORKER_RELEASE_READINESS_CONTRACT
  expected_sha: string
  failover_regions: string[]
  healthy_workers: ReleaseWorker[]
  invalid_nodes: string[]
  missing_regions: string[]
  ready: boolean
  required_regions: string[]
  stale_workers: ReleaseWorker[]
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
 * Evaluate the live Redis worker roster against one exact release SHA. A
 * required region is safe only when an exact-SHA worker covers it, and every
 * other fresh worker touching the required fleet is on that same SHA.
 */
export function evaluateWorkerReleaseReadiness(
  roster: Record<string, unknown> | null,
  expectedSha: string,
  now = Date.now(),
  failoverFlag: unknown = null
): WorkerReleaseReadiness {
  if (!COMMIT_SHA.test(expectedSha)) throw new Error('expected worker SHA is invalid')

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
      regions,
      sha: typeof beat.sha === 'string' && COMMIT_SHA.test(beat.sha) ? beat.sha : 'unknown',
    }
    if (ageMs >= WORKER_HEARTBEAT_STALE_MS) staleWorkers.push(worker)
    else healthyWorkers.push(worker)
  }

  const missingRegions = REQUIRED_RELEASE_REGIONS.filter(
    (region) =>
      !healthyWorkers.some(
        (worker) => worker.sha === expectedSha && worker.regions.includes(region)
      )
  )
  const mismatchedWorkerExists = healthyWorkers.some((worker) => worker.sha !== expectedSha)
  const disabledCaptureExists = healthyWorkers.some((worker) => !worker.attempt_bound_capture)
  const failoverRegions = parseFailoverRegions(failoverFlag)
  const exactOwners = REQUIRED_RELEASE_REGIONS.map((region) =>
    healthyWorkers.filter((worker) => worker.sha === expectedSha && worker.regions.includes(region))
  )
  const uniqueOwnerNodes = new Set(exactOwners.flat().map((worker) => worker.node))
  const topologyIsExact =
    exactOwners.every((owners) => owners.length === 1) &&
    uniqueOwnerNodes.size === REQUIRED_RELEASE_REGIONS.length

  return {
    contract: WORKER_RELEASE_READINESS_CONTRACT,
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
