export interface PlatformHealth {
  platform: string
  displayName: string
  lastUpdate: string | null
  ageHours: number | null
  currentCount: number
  avgCount: number | null
  countRatio: number | null
  status: 'healthy' | 'warning' | 'critical'
}

export type PlatformHealthStatus = 'healthy' | 'degraded' | 'critical'

export interface PlatformFreshnessRow {
  source?: string | null
  platform?: string | null
  latest?: string | Date | null
  updated_at?: string | Date | null
  computed_at?: string | Date | null
}

interface PlatformLogRow {
  job_name: string
  records_processed: number | null
}

interface BuildPlatformHealthOptions {
  freshnessRows: PlatformFreshnessRow[]
  logs: PlatformLogRow[]
  now: number
  getDisplayName?: (platform: string) => string
}

/**
 * Build health rows from the source registry-backed freshness RPC.
 *
 * The RPC result is the authority for which sources are active. In particular,
 * callers must not merge this with historical static allowlists: an active
 * source with no snapshots is represented by latest=null and remains critical,
 * while inactive/retired sources are absent.
 */
export function buildPlatformHealth({
  freshnessRows,
  logs,
  now,
  getDisplayName = (platform) => platform,
}: BuildPlatformHealthOptions): PlatformHealth[] {
  if (freshnessRows.length === 0) {
    throw new Error('active platform freshness RPC returned no rows')
  }

  const activePlatforms = new Set<string>()
  const latestByPlatform = new Map<string, { iso: string; timestamp: number }>()

  for (const row of freshnessRows) {
    const platform = (row.source ?? row.platform ?? '').trim()
    if (!platform) {
      throw new Error('active platform freshness RPC returned a blank source')
    }
    if (activePlatforms.has(platform)) {
      throw new Error(`active platform freshness RPC returned duplicate source: ${platform}`)
    }

    activePlatforms.add(platform)

    const rawTimestamp = row.latest ?? row.updated_at ?? row.computed_at
    if (!rawTimestamp) continue

    const timestamp =
      rawTimestamp instanceof Date ? rawTimestamp.getTime() : new Date(rawTimestamp).getTime()
    if (!Number.isFinite(timestamp)) {
      throw new Error(`active platform freshness RPC returned an invalid timestamp: ${platform}`)
    }
    if (timestamp > now + 5 * 60 * 1000) {
      throw new Error(`active platform freshness RPC returned a future timestamp: ${platform}`)
    }

    latestByPlatform.set(platform, {
      iso: new Date(timestamp).toISOString(),
      timestamp,
    })
  }

  return [...activePlatforms]
    .map((platform): PlatformHealth => {
      const latest = latestByPlatform.get(platform)
      const matchingLogs = logs.filter((log) => log.job_name.includes(platform))
      const avgCount =
        matchingLogs.length > 0
          ? matchingLogs.reduce((sum, log) => sum + (log.records_processed || 0), 0) /
            matchingLogs.length
          : null
      const ageHours = latest
        ? Math.round(((now - latest.timestamp) / (1000 * 60 * 60)) * 10) / 10
        : null

      let status: PlatformHealth['status'] = 'healthy'
      if (ageHours == null || ageHours > 24) {
        status = 'critical'
      } else if (ageHours > 6) {
        status = 'warning'
      }

      return {
        platform,
        displayName: getDisplayName(platform),
        lastUpdate: latest?.iso ?? null,
        ageHours,
        // Count queries are intentionally disabled in the health route. Keep
        // the established response contract while avgCount remains available.
        currentCount: 0,
        avgCount: avgCount != null ? Math.round(avgCount) : null,
        countRatio: null,
        status,
      }
    })
    .sort((a, b) => a.platform.localeCompare(b.platform))
}

/**
 * Escalate any real platform failure while reserving critical for a source that
 * never initialized or a broad outage. A single stale source must not leave the
 * endpoint body "healthy", because external monitors key off that body status.
 */
export function classifyPlatformHealth(platforms: PlatformHealth[]): PlatformHealthStatus {
  if (platforms.length === 0) {
    throw new Error('cannot classify an empty active platform set')
  }

  const critical = platforms.filter((platform) => platform.status === 'critical').length
  const warning = platforms.filter((platform) => platform.status === 'warning').length
  const neverFetched = platforms.some((platform) => platform.lastUpdate === null)

  if (neverFetched || critical > platforms.length * 0.3) {
    return 'critical'
  }
  if (critical > 0 || warning > platforms.length * 0.3) {
    return 'degraded'
  }
  return 'healthy'
}
