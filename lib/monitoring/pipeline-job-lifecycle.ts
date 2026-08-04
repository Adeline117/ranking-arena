/**
 * Pipeline log identities that no longer represent executable production work.
 *
 * Pipeline logs are retained for incident history, so retired jobs can remain
 * visible for days after their routes and workers are removed. Monitoring must
 * treat these names as tombstones, not as current health authority.
 */
const RETIRED_JOB_PREFIXES = [
  'batch-enrich',
  'batch-fetch-traders',
  'fetch-details',
  'fetch-traders',
] as const

const RETIRED_JOB_NAMES = new Set([
  'auto-post-insights',
  'backfill-data',
  'batch-discover',
  'calculate-advanced-metrics',
  'cleanup-violations',
  'compute-derived-metrics',
  'enrich-gmx',
  'ensure-partitions',
  'hot-score-refresh',
  'link-entities',
  'pipeline-fetch',
  'retry-dead-letters',
  'snapshot-positions',
  'unified-connector',
  'verify-fetchers',
])

const PIPELINE_JOB_NAME_MAX_LENGTH = 200
const PIPELINE_JOB_NAME_PATTERN =
  /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?(?:,[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?)*$/i

const PIPELINE_STATUS_HEALTH_PAIRS = new Map<string, ReadonlySet<string>>([
  ['running', new Set(['running', 'stuck'])],
  ['success', new Set(['healthy', 'stale'])],
  ['partial_success', new Set(['partial_success'])],
  ['error', new Set(['failed'])],
  ['timeout', new Set(['failed'])],
])

export type PipelineJobLifecycle = 'active' | 'blocked_platform' | 'retired' | 'invalid'

function normalizePipelineJobName(jobName: unknown): string | null {
  if (typeof jobName !== 'string') return null
  if (jobName.length === 0 || jobName.length > PIPELINE_JOB_NAME_MAX_LENGTH) return null
  if (jobName !== jobName.trim() || !PIPELINE_JOB_NAME_PATTERN.test(jobName)) return null
  return jobName.toLowerCase()
}

function normalizePlatformSet(platforms: readonly string[]): ReadonlySet<string> {
  return new Set(
    platforms
      .filter((platform) => typeof platform === 'string' && platform.length > 0)
      .map((platform) => platform.toLowerCase())
  )
}

/**
 * Classify a retained pipeline-log identity without allowing malformed values
 * to become current monitoring authority.
 *
 * Platform-scoped jobs put their platform identity (or comma-separated
 * identities) after the final `-`. A combined job is blocked only when every
 * platform in that suffix is blocked. This keeps a live consolidated job such
 * as `backfill-avatars-drift,toobit` visible while still tombstoning the
 * single-platform `backfill-avatars-drift` form.
 */
export function classifyPipelineJobIdentity(
  jobName: unknown,
  blockedPlatforms: readonly string[] = []
): PipelineJobLifecycle {
  const normalized = normalizePipelineJobName(jobName)
  if (normalized === null) return 'invalid'

  if (RETIRED_JOB_NAMES.has(normalized)) return 'retired'
  if (
    RETIRED_JOB_PREFIXES.some(
      (prefix) => normalized === prefix || normalized.startsWith(prefix + '-')
    )
  ) {
    return 'retired'
  }

  const blockedSet = normalizePlatformSet(blockedPlatforms)
  if (blockedSet.size > 0) {
    if (blockedSet.has(normalized)) return 'blocked_platform'

    const suffix = normalized.slice(normalized.lastIndexOf('-') + 1)
    const platformIdentities = suffix.split(',')
    if (
      platformIdentities.length > 0 &&
      platformIdentities.every((platform) => blockedSet.has(platform))
    ) {
      return 'blocked_platform'
    }
  }

  return 'active'
}

/**
 * Validate the database status/health-status pair as one identity. Accepting
 * either field independently can turn a corrupt or schema-drifted row into a
 * false healthy signal.
 */
export function isAuthoritativePipelineStatusIdentity(
  status: unknown,
  healthStatus: unknown
): boolean {
  if (typeof status !== 'string' || typeof healthStatus !== 'string') return false
  if (status !== status.trim() || healthStatus !== healthStatus.trim()) return false
  return PIPELINE_STATUS_HEALTH_PAIRS.get(status)?.has(healthStatus) ?? false
}

export function isRetiredPipelineJobName(jobName: unknown): boolean {
  return classifyPipelineJobIdentity(jobName) === 'retired'
}
