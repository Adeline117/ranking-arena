import {
  REQUIRED_RELEASE_REGIONS,
  WORKER_HEARTBEAT_DECOMMISSION_MS,
  WORKER_HEARTBEAT_STALE_MS,
} from './worker-release-readiness'

const CLOCK_SKEW_TOLERANCE_MS = 60_000
const COMMIT_SHA = /^[0-9a-f]{40}$/
const RELEASE_ID = /^[0-9a-f]{64}$/
const REQUIRED_REGION_SET = new Set<string>(REQUIRED_RELEASE_REGIONS)

interface RawHeartbeat {
  attempt_bound_capture?: unknown
  regions?: unknown
  release_id?: unknown
  sha?: unknown
  ts?: unknown
}

export interface WorkerTopologyOwner {
  attempt_bound_capture: boolean
  node: string
  release_id: string
  sha: string
}

export interface WorkerHeartbeatTopology {
  capture_disabled_nodes: string[]
  combined_owner_nodes: string[]
  distinct_release_ids: string[]
  duplicate_regions: string[]
  invalid_nodes: Array<{ node: string; reason: string }>
  invalid_release_nodes: string[]
  missing_regions: string[]
  owners: Record<string, WorkerTopologyOwner[]>
  ready: boolean
  required_regions: string[]
}

function decodeHeartbeat(raw: unknown): RawHeartbeat | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as RawHeartbeat
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
        region.length > 80 ||
        region.trim() !== region
    )
  ) {
    return null
  }
  return [...new Set(value as string[])].sort()
}

/**
 * Evaluate the continuously running worker fleet without binding it to the
 * current web commit. A healthy fleet has one distinct owner per required
 * region, one deterministic release across those owners, and capture enabled.
 * Git SHA is retained as audit evidence only, so app-only commits do not page.
 *
 * Every roster entry is isolated: malformed JSON, timestamps, or region data
 * becomes explicit evidence instead of throwing and aborting the whole cron.
 */
export function evaluateWorkerHeartbeatTopology(
  roster: Record<string, unknown> | null,
  now = Date.now()
): WorkerHeartbeatTopology {
  const owners = Object.fromEntries(
    REQUIRED_RELEASE_REGIONS.map((region) => [region, [] as WorkerTopologyOwner[]])
  ) as Record<string, WorkerTopologyOwner[]>
  const invalidNodes: Array<{ node: string; reason: string }> = []

  for (const [rawNode, raw] of Object.entries(roster ?? {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const node = rawNode.trim()
    if (!node || node !== rawNode || node.length > 160) {
      invalidNodes.push({ node: node || '(empty)', reason: 'invalid_node' })
      continue
    }

    const beat = decodeHeartbeat(raw)
    if (!beat) {
      invalidNodes.push({ node, reason: 'invalid_payload' })
      continue
    }
    if (!Number.isSafeInteger(beat.ts) || Number(beat.ts) <= 0) {
      invalidNodes.push({ node, reason: 'invalid_ts' })
      continue
    }

    const ageMs = now - Number(beat.ts)
    if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
      invalidNodes.push({ node, reason: 'future_ts' })
      continue
    }
    if (ageMs >= WORKER_HEARTBEAT_DECOMMISSION_MS) continue

    const regions = parseRegions(beat.regions)
    if (!regions) {
      invalidNodes.push({ node, reason: 'invalid_regions' })
      continue
    }
    if (ageMs >= WORKER_HEARTBEAT_STALE_MS) continue

    const requiredRegions = regions.filter((region) => REQUIRED_REGION_SET.has(region))
    if (requiredRegions.length === 0) continue

    const owner: WorkerTopologyOwner = {
      attempt_bound_capture: beat.attempt_bound_capture === true,
      node,
      release_id:
        typeof beat.release_id === 'string' && RELEASE_ID.test(beat.release_id)
          ? beat.release_id
          : 'unknown',
      sha: typeof beat.sha === 'string' && COMMIT_SHA.test(beat.sha) ? beat.sha : 'unknown',
    }
    for (const region of requiredRegions) owners[region].push(owner)
  }

  const ownerNodes = new Map<string, Set<string>>()
  for (const [region, regionOwners] of Object.entries(owners)) {
    for (const owner of regionOwners) {
      const regions = ownerNodes.get(owner.node) ?? new Set<string>()
      regions.add(region)
      ownerNodes.set(owner.node, regions)
    }
  }

  const requiredOwners = [
    ...new Map(
      Object.values(owners)
        .flat()
        .map((owner) => [owner.node, owner])
    ).values(),
  ]
  const missingRegions = REQUIRED_RELEASE_REGIONS.filter((region) => owners[region].length === 0)
  const duplicateRegions = REQUIRED_RELEASE_REGIONS.filter((region) => owners[region].length > 1)
  const combinedOwnerNodes = [...ownerNodes.entries()]
    .filter(([, regions]) => regions.size > 1)
    .map(([node]) => node)
    .sort()
  const invalidReleaseNodes = requiredOwners
    .filter((owner) => !RELEASE_ID.test(owner.release_id))
    .map((owner) => owner.node)
    .sort()
  const captureDisabledNodes = requiredOwners
    .filter((owner) => !owner.attempt_bound_capture)
    .map((owner) => owner.node)
    .sort()
  const distinctReleaseIds = [
    ...new Set(
      requiredOwners
        .map((owner) => owner.release_id)
        .filter((releaseId) => RELEASE_ID.test(releaseId))
    ),
  ].sort()

  return {
    capture_disabled_nodes: captureDisabledNodes,
    combined_owner_nodes: combinedOwnerNodes,
    distinct_release_ids: distinctReleaseIds,
    duplicate_regions: [...duplicateRegions],
    invalid_nodes: invalidNodes,
    invalid_release_nodes: invalidReleaseNodes,
    missing_regions: [...missingRegions],
    owners,
    ready:
      invalidNodes.length === 0 &&
      missingRegions.length === 0 &&
      duplicateRegions.length === 0 &&
      combinedOwnerNodes.length === 0 &&
      invalidReleaseNodes.length === 0 &&
      captureDisabledNodes.length === 0 &&
      distinctReleaseIds.length === 1,
    required_regions: [...REQUIRED_RELEASE_REGIONS],
  }
}
