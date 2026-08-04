export const PUBLIC_STATUS_REQUEST_TIMEOUT_MS = 15_000

export type PublicHealthStatus = 'healthy' | 'degraded' | 'unhealthy'
export type PublicCheckStatus = 'pass' | 'fail' | 'skip'

export type PublicHealthCheck = {
  status: PublicCheckStatus
  message?: string
  latency?: number
}

export type PublicHealthSnapshot = {
  status: PublicHealthStatus
  timestamp: string
  version: string
  commit: string
  uptime: number
  responseTimeMs: number
  checks: Record<string, PublicHealthCheck>
}

export type PublicPlatformHealth = {
  platform: string
  status: string
  lastSuccessAt: string | null
  errorCount: number
}

export type PublicPlatformHealthSnapshot = {
  platforms: PublicPlatformHealth[]
  freshness: Record<string, string>
}

const COMPONENT_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const SAFE_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional])
  const actual = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) && actual.every((key) => allowed.has(key))
  )
}

function canonicalTimestamp(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp > nowMs + MAX_FUTURE_SKEW_MS) return null
  return new Date(timestamp).toISOString()
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isNonnegativeSafeInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER
): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
}

function readHealthCheck(value: unknown): PublicHealthCheck | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status'], ['latency', 'message']) ||
    (value.status !== 'pass' && value.status !== 'fail' && value.status !== 'skip') ||
    (value.latency !== undefined && !isNonnegativeSafeInteger(value.latency, 120_000)) ||
    (value.message !== undefined && !isBoundedText(value.message, 240))
  ) {
    return null
  }

  return {
    status: value.status,
    ...(value.latency === undefined ? {} : { latency: value.latency as number }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
  }
}

export function readPublicHealthSnapshot(
  value: unknown,
  nowMs = Date.now()
): PublicHealthSnapshot | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      '_detail',
      'checks',
      'commit',
      'responseTimeMs',
      'status',
      'timestamp',
      'uptime',
      'version',
    ]) ||
    (value.status !== 'healthy' && value.status !== 'degraded' && value.status !== 'unhealthy') ||
    value._detail !== '/api/health/detailed' ||
    !isBoundedText(value.version, 64) ||
    !SAFE_LABEL_PATTERN.test(value.version) ||
    !isBoundedText(value.commit, 128) ||
    !SAFE_LABEL_PATTERN.test(value.commit) ||
    !isNonnegativeSafeInteger(value.uptime) ||
    !isNonnegativeSafeInteger(value.responseTimeMs, 120_000) ||
    !isRecord(value.checks)
  ) {
    return null
  }

  const timestamp = canonicalTimestamp(value.timestamp, nowMs)
  if (!timestamp) return null

  const checks: Record<string, PublicHealthCheck> = {}
  const entries = Object.entries(value.checks)
  if (entries.length === 0) return null
  for (const [name, rawCheck] of entries) {
    const check = COMPONENT_KEY_PATTERN.test(name) ? readHealthCheck(rawCheck) : null
    if (!check) return null
    checks[name] = check
  }

  return {
    status: value.status,
    timestamp,
    version: value.version,
    commit: value.commit,
    uptime: value.uptime,
    responseTimeMs: value.responseTimeMs,
    checks,
  }
}

export function readPublicPlatformHealthSnapshot(
  value: unknown,
  nowMs = Date.now()
): PublicPlatformHealthSnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, ['freshness', 'platforms'])) return null
  if (!Array.isArray(value.platforms) || !isRecord(value.freshness)) return null

  const platforms: PublicPlatformHealth[] = []
  const seenPlatforms = new Set<string>()
  for (const rawPlatform of value.platforms) {
    if (
      !isRecord(rawPlatform) ||
      !hasExactKeys(rawPlatform, ['error_count', 'last_success_at', 'platform', 'status']) ||
      !isBoundedText(rawPlatform.platform, 128) ||
      !COMPONENT_KEY_PATTERN.test(rawPlatform.platform) ||
      seenPlatforms.has(rawPlatform.platform) ||
      !isBoundedText(rawPlatform.status, 64) ||
      !SAFE_LABEL_PATTERN.test(rawPlatform.status) ||
      !isNonnegativeSafeInteger(rawPlatform.error_count)
    ) {
      return null
    }
    const lastSuccessAt =
      rawPlatform.last_success_at === null
        ? null
        : canonicalTimestamp(rawPlatform.last_success_at, nowMs)
    if (rawPlatform.last_success_at !== null && !lastSuccessAt) return null
    seenPlatforms.add(rawPlatform.platform)
    platforms.push({
      platform: rawPlatform.platform,
      status: rawPlatform.status,
      lastSuccessAt,
      errorCount: rawPlatform.error_count,
    })
  }

  const freshness: Record<string, string> = {}
  for (const [platform, rawTimestamp] of Object.entries(value.freshness)) {
    const timestamp =
      COMPONENT_KEY_PATTERN.test(platform) && canonicalTimestamp(rawTimestamp, nowMs)
    if (!timestamp) return null
    freshness[platform] = timestamp
  }

  return { platforms, freshness }
}
