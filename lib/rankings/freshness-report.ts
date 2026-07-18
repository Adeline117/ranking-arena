export const FRESHNESS_STATUSES = ['fresh', 'stale', 'critical', 'unknown'] as const

export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number]

export interface PlatformFreshnessStatus {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageMs: number | null
  ageHours: number | null
  status: FreshnessStatus
  recordCount: number
}

export interface FreshnessReport {
  ok: boolean
  checked_at: string
  summary: {
    total: number
    fresh: number
    stale: number
    critical: number
    unknown: number
  }
  thresholds: {
    stale_hours: number
    critical_hours: number
  }
  platforms: PlatformFreshnessStatus[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function timestamp(value: unknown, label: string): string {
  const text = nonEmptyString(value, label)
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be a timestamp`)
  return text
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label)
}

function finiteNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNonNegativeNumber(value, label)
  if (!Number.isSafeInteger(number)) throw new TypeError(`${label} must be an integer`)
  return number
}

function nullableFiniteNonNegativeNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNonNegativeNumber(value, label)
}

function status(value: unknown, label: string): FreshnessStatus {
  if (!FRESHNESS_STATUSES.includes(value as FreshnessStatus)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as FreshnessStatus
}

/**
 * Validate the authenticated admin response before it can be rendered.
 *
 * A 401 body, an HTML error page parsed as null, or a partially deployed
 * contract must never become an empty/healthy dashboard.
 */
export function parseFreshnessReport(value: unknown): FreshnessReport {
  const report = record(value, 'freshness report')
  if (typeof report.ok !== 'boolean') throw new TypeError('freshness report ok must be boolean')

  const summaryRecord = record(report.summary, 'freshness summary')
  const summary = {
    total: nonNegativeInteger(summaryRecord.total, 'freshness summary total'),
    fresh: nonNegativeInteger(summaryRecord.fresh, 'freshness summary fresh'),
    stale: nonNegativeInteger(summaryRecord.stale, 'freshness summary stale'),
    critical: nonNegativeInteger(summaryRecord.critical, 'freshness summary critical'),
    unknown: nonNegativeInteger(summaryRecord.unknown, 'freshness summary unknown'),
  }

  const thresholdRecord = record(report.thresholds, 'freshness thresholds')
  const thresholds = {
    stale_hours: finiteNonNegativeNumber(thresholdRecord.stale_hours, 'freshness stale threshold'),
    critical_hours: finiteNonNegativeNumber(
      thresholdRecord.critical_hours,
      'freshness critical threshold'
    ),
  }
  if (thresholds.critical_hours <= thresholds.stale_hours) {
    throw new TypeError('freshness critical threshold must exceed stale threshold')
  }

  if (!Array.isArray(report.platforms)) {
    throw new TypeError('freshness platforms must be an array')
  }
  const seenPlatforms = new Set<string>()
  const platforms = report.platforms.map((value, index): PlatformFreshnessStatus => {
    const platformRecord = record(value, `freshness platform ${index}`)
    const platform = nonEmptyString(platformRecord.platform, `freshness platform ${index} id`)
    if (seenPlatforms.has(platform)) throw new TypeError('freshness platforms must be unique')
    seenPlatforms.add(platform)

    return {
      platform,
      displayName: nonEmptyString(
        platformRecord.displayName,
        `freshness platform ${index} displayName`
      ),
      lastUpdate: nullableTimestamp(
        platformRecord.lastUpdate,
        `freshness platform ${index} lastUpdate`
      ),
      ageMs: nullableFiniteNonNegativeNumber(
        platformRecord.ageMs,
        `freshness platform ${index} ageMs`
      ),
      ageHours: nullableFiniteNonNegativeNumber(
        platformRecord.ageHours,
        `freshness platform ${index} ageHours`
      ),
      status: status(platformRecord.status, `freshness platform ${index} status`),
      recordCount: nonNegativeInteger(
        platformRecord.recordCount,
        `freshness platform ${index} recordCount`
      ),
    }
  })

  const statusCounts = Object.fromEntries(
    FRESHNESS_STATUSES.map((freshnessStatus) => [
      freshnessStatus,
      platforms.filter((platform) => platform.status === freshnessStatus).length,
    ])
  ) as Record<FreshnessStatus, number>
  if (
    summary.total !== platforms.length ||
    summary.total !== summary.fresh + summary.stale + summary.critical + summary.unknown ||
    summary.fresh !== statusCounts.fresh ||
    summary.stale !== statusCounts.stale ||
    summary.critical !== statusCounts.critical ||
    summary.unknown !== statusCounts.unknown
  ) {
    throw new TypeError('freshness summary does not match platform statuses')
  }

  const expectedOk = summary.stale === 0 && summary.critical === 0 && summary.unknown === 0
  if (report.ok !== expectedOk) throw new TypeError('freshness ok does not match summary')

  return {
    ok: report.ok,
    checked_at: timestamp(report.checked_at, 'freshness checked_at'),
    summary,
    thresholds,
    platforms,
  }
}
