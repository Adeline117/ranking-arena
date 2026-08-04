import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  parseVisibleLeaderboardSources,
  type LeaderboardTimeRange,
} from '@/lib/data/visible-leaderboard-sources'
import {
  buildRegistrySourceFreshnessStatuses,
  parseExpectedSourceWindows,
  type ExpectedSourceWindow,
  type VisibleSourceWindow,
} from '@/lib/rankings/source-freshness'
import type { FreshnessReport, PlatformFreshnessStatus } from '@/lib/rankings/freshness-report'

const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000
const CRITICAL_THRESHOLD_MS = 24 * 60 * 60 * 1000
const RANKING_SEASONS: readonly LeaderboardTimeRange[] = ['7D', '30D', '90D']

const PLATFORM_THRESHOLD_OVERRIDES: Record<string, { stale: number; critical: number }> = {
  blofin: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 },
  gmx: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 },
  gains: { stale: 48 * 60 * 60 * 1000, critical: 72 * 60 * 60 * 1000 },
}

interface PublicationFreshnessRow {
  season_id: unknown
  source: unknown
  source_as_of: unknown
  recorded_at: unknown
  score_cohort_id: unknown
  published_rank_count: unknown
}

export interface FreshnessAuthoritySnapshot {
  report: FreshnessReport
  coverage: {
    expectedSourceBoards: number
    visibleSourceBoards: number
  }
  /**
   * A complete current 90D publication, proven only when every expected public
   * source points at the same sealed cohort and publication timestamp.
   */
  latestSuccessfulPublication: {
    season: '90D'
    publishedAt: string
  } | null
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size
}

function sourceWindowKey(season: ExpectedSourceWindow['season_id'], registrySlug: string): string {
  return `${season}\u0000${registrySlug}`
}

function publicationTimestamp(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60 * 1000) return null
  return new Date(timestamp).toISOString()
}

function isRuntimeRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The production migration is ahead of the checked-in generated Supabase
 * schema. Keep that generated file immutable and narrow the database boundary
 * locally until the next production schema generation includes these columns.
 */
function parsePublicationFreshnessRows(data: unknown): PublicationFreshnessRow[] {
  if (!Array.isArray(data)) {
    throw new TypeError('source watermark freshness authority did not return rows')
  }

  return data.map((value, index) => {
    if (!isRuntimeRow(value)) {
      throw new TypeError(`source watermark freshness row ${index} is not an object`)
    }

    return {
      season_id: value.season_id,
      source: value.source,
      source_as_of: value.source_as_of,
      recorded_at: value.recorded_at,
      score_cohort_id: value.score_cohort_id,
      published_rank_count: value.published_rank_count,
    }
  })
}

/**
 * Derive public metadata from the same registry/watermark authority used by
 * the freshness report. This deliberately returns `null` instead of guessing
 * when the current source rows do not prove one complete 90D publication.
 */
export function deriveFreshnessAuthorityMetadata(
  expectedWindows: readonly ExpectedSourceWindow[],
  visibleWindows: readonly VisibleSourceWindow[],
  watermarkRows: readonly PublicationFreshnessRow[],
  now = Date.now()
): Pick<FreshnessAuthoritySnapshot, 'coverage' | 'latestSuccessfulPublication'> {
  const expectedSourceBoards = uniqueCount(expectedWindows.map((window) => window.registry_slug))
  const visibleWindowKeys = new Set(
    visibleWindows.map((window) => sourceWindowKey(window.season_id, window.registry_slug))
  )
  const expectedWindowsByBoard = new Map<string, ExpectedSourceWindow[]>()
  for (const window of expectedWindows) {
    const windows = expectedWindowsByBoard.get(window.registry_slug) ?? []
    windows.push(window)
    expectedWindowsByBoard.set(window.registry_slug, windows)
  }
  const visibleSourceBoards = [...expectedWindowsByBoard.values()].filter((windows) =>
    windows.every((window) =>
      visibleWindowKeys.has(sourceWindowKey(window.season_id, window.registry_slug))
    )
  ).length
  const expected90dSources = new Set(
    expectedWindows.filter((window) => window.season_id === '90D').map((window) => window.source)
  )

  const currentRows = new Map<
    string,
    { cohortId: string; publishedAt: string; publishedRankCount: number }
  >()
  let invalid = expected90dSources.size === 0

  for (const row of watermarkRows) {
    if (row.season_id !== '90D' || typeof row.source !== 'string') continue
    if (!expected90dSources.has(row.source)) continue
    if (currentRows.has(row.source)) {
      invalid = true
      continue
    }

    const publishedAt = publicationTimestamp(row.recorded_at, now)
    const cohortId =
      typeof row.score_cohort_id === 'string' && row.score_cohort_id.length > 0
        ? row.score_cohort_id
        : null
    const publishedRankCount = row.published_rank_count
    if (
      publishedAt === null ||
      cohortId === null ||
      typeof publishedRankCount !== 'number' ||
      !Number.isSafeInteger(publishedRankCount) ||
      publishedRankCount <= 0
    ) {
      invalid = true
      continue
    }
    currentRows.set(row.source, { cohortId, publishedAt, publishedRankCount })
  }

  if (currentRows.size !== expected90dSources.size) invalid = true
  const publicationRows = [...currentRows.values()]
  const cohortIds = new Set(publicationRows.map((row) => row.cohortId))
  const publicationTimes = new Set(publicationRows.map((row) => row.publishedAt))
  if (cohortIds.size !== 1 || publicationTimes.size !== 1) invalid = true

  return {
    coverage: { expectedSourceBoards, visibleSourceBoards },
    latestSuccessfulPublication: invalid
      ? null
      : {
          season: '90D',
          publishedAt: publicationRows[0].publishedAt,
        },
  }
}

/**
 * Load the launch freshness authority shared by cron, admin, and public health.
 *
 * Registry promises, current-generation visibility, and upstream watermarks
 * are independent authorities. Keeping all three prevents one recent source
 * from hiding a missing or stale source/window behind a global MAX timestamp.
 */
export async function buildFreshnessAuthoritySnapshot(
  signal?: AbortSignal
): Promise<FreshnessAuthoritySnapshot> {
  const supabase = getSupabaseAdmin()
  const now = Date.now()

  const expectedQuery = supabase.rpc('arena_freshness_expected_sources')
  const watermarkQuery = supabase
    .from('leaderboard_source_freshness')
    .select('season_id,source,source_as_of,recorded_at,score_cohort_id,published_rank_count')
    .in('season_id', [...RANKING_SEASONS])

  const [expectedResult, visibleBySeason, watermarkResult] = await Promise.all([
    signal ? expectedQuery.abortSignal(signal) : expectedQuery,
    Promise.all(
      RANKING_SEASONS.map(async (season) => {
        const visibleQuery = supabase.rpc('arena_visible_sources', {
          p_season_id: season,
        })
        return {
          season,
          result: await (signal ? visibleQuery.abortSignal(signal) : visibleQuery),
        }
      })
    ),
    signal ? watermarkQuery.abortSignal(signal) : watermarkQuery,
  ])

  if (expectedResult.error) {
    throw new Error('freshness expected source authority is unavailable')
  }
  const expectedWindows = parseExpectedSourceWindows(expectedResult.data)

  const visibleWindows: VisibleSourceWindow[] = visibleBySeason.flatMap(({ season, result }) => {
    if (result.error) {
      throw new Error('visible source freshness authority is unavailable')
    }
    return parseVisibleLeaderboardSources(result.data).map((source) => ({
      season_id: season,
      registry_slug: source.registrySlug,
      source: source.filterSource,
      display_name: source.exchangeName,
      record_count: source.traderCount,
    }))
  })
  if (watermarkResult.error) {
    throw new Error('source watermark freshness authority is unavailable')
  }
  const watermarkRows = parsePublicationFreshnessRows(watermarkResult.data)

  const sourceStatuses = buildRegistrySourceFreshnessStatuses(
    expectedWindows,
    visibleWindows,
    watermarkRows,
    now
  )
  const results: PlatformFreshnessStatus[] = []
  const stalePlatforms: string[] = []
  const criticalPlatforms: string[] = []
  const unknownPlatforms: string[] = []

  for (const source of sourceStatuses) {
    let ageMs: number | null = null
    let ageHours: number | null = null
    let status: PlatformFreshnessStatus['status'] = 'unknown'

    if (source.issues.length > 0 || source.updated_at === null) {
      unknownPlatforms.push(source.source)
    } else {
      ageMs = Math.max(0, now - Date.parse(source.updated_at))
      ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10
      const overrides = PLATFORM_THRESHOLD_OVERRIDES[source.source]
      const criticalThreshold = overrides?.critical ?? CRITICAL_THRESHOLD_MS
      const staleThreshold = overrides?.stale ?? STALE_THRESHOLD_MS

      if (ageMs >= criticalThreshold) {
        status = 'critical'
        criticalPlatforms.push(source.source)
      } else if (ageMs >= staleThreshold) {
        status = 'stale'
        stalePlatforms.push(source.source)
      } else {
        status = 'fresh'
      }
    }

    results.push({
      platform: source.source,
      displayName: source.display_name,
      lastUpdate: source.updated_at,
      ageMs,
      ageHours,
      status,
      recordCount: source.record_count,
    })
  }

  const freshCount = results.filter((result) => result.status === 'fresh').length

  const report: FreshnessReport = {
    ok:
      criticalPlatforms.length === 0 &&
      stalePlatforms.length === 0 &&
      unknownPlatforms.length === 0,
    checked_at: new Date(now).toISOString(),
    summary: {
      total: results.length,
      fresh: freshCount,
      stale: stalePlatforms.length,
      critical: criticalPlatforms.length,
      unknown: unknownPlatforms.length,
    },
    thresholds: {
      stale_hours: STALE_THRESHOLD_MS / (1000 * 60 * 60),
      critical_hours: CRITICAL_THRESHOLD_MS / (1000 * 60 * 60),
    },
    platforms: results,
  }

  return {
    report,
    ...deriveFreshnessAuthorityMetadata(expectedWindows, visibleWindows, watermarkRows, now),
  }
}

export async function buildFreshnessReport(signal?: AbortSignal): Promise<FreshnessReport> {
  return (await buildFreshnessAuthoritySnapshot(signal)).report
}
