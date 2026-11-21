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
import type {
  FreshnessReport,
  PlatformFreshnessStatus,
  SourceQuarantine,
} from '@/lib/rankings/freshness-report'

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

export interface SourceIsolationRow {
  season_id: string
  filter_source: string
  reasons: string[]
  first_isolated_at: string
  isolated_at: string
}

/** PostgREST / PostgreSQL "function does not exist" (isolation not installed). */
const MISSING_FUNCTION_CODES = new Set(['PGRST202', '42883'])

function parseSourceIsolationRows(data: unknown): SourceIsolationRow[] {
  if (!Array.isArray(data)) {
    throw new TypeError('source isolation authority did not return rows')
  }
  return data.map((value, index) => {
    if (
      !isRuntimeRow(value) ||
      typeof value.season_id !== 'string' ||
      typeof value.filter_source !== 'string' ||
      !Array.isArray(value.reasons) ||
      !value.reasons.every((reason) => typeof reason === 'string') ||
      typeof value.first_isolated_at !== 'string' ||
      typeof value.isolated_at !== 'string'
    ) {
      throw new TypeError(`source isolation row ${index} is malformed`)
    }
    return {
      season_id: value.season_id,
      filter_source: value.filter_source,
      reasons: value.reasons as string[],
      first_isolated_at: value.first_isolated_at,
      isolated_at: value.isolated_at,
    }
  })
}

function latestWatermark(rows: readonly PublicationFreshnessRow[], source: string): string | null {
  let latest: string | null = null
  for (const row of rows) {
    if (row.source !== source || typeof row.source_as_of !== 'string') continue
    if (!Number.isFinite(Date.parse(row.source_as_of))) continue
    if (latest === null || Date.parse(row.source_as_of) > Date.parse(latest)) {
      latest = row.source_as_of
    }
  }
  return latest
}

/**
 * Isolated sources leave the season's expected set, so without this they
 * would silently vanish from the report. List every isolated source with its
 * seasons, reasons and isolation start. A source that is otherwise fresh
 * becomes `quarantined`; stale/critical/unknown stays the worse status.
 */
export function applySourceQuarantine(
  platforms: readonly PlatformFreshnessStatus[],
  isolations: readonly SourceIsolationRow[],
  watermarkRows: readonly PublicationFreshnessRow[],
  now = Date.now()
): PlatformFreshnessStatus[] {
  const bySource = new Map<string, SourceQuarantine[]>()
  for (const isolation of isolations) {
    const list = bySource.get(isolation.filter_source) ?? []
    list.push({
      season: isolation.season_id,
      reasons: [...isolation.reasons],
      since: isolation.first_isolated_at,
      lastConfirmedAt: isolation.isolated_at,
    })
    bySource.set(isolation.filter_source, list)
  }
  const result = platforms.map((platform) => {
    const quarantine = bySource.get(platform.platform)
    if (!quarantine) return platform
    bySource.delete(platform.platform)
    return {
      ...platform,
      status: platform.status === 'fresh' ? ('quarantined' as const) : platform.status,
      quarantine: quarantine.sort((a, b) => a.season.localeCompare(b.season)),
    }
  })
  for (const [source, quarantine] of [...bySource.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const lastUpdate = latestWatermark(watermarkRows, source)
    const ageMs = lastUpdate === null ? null : Math.max(0, now - Date.parse(lastUpdate))
    result.push({
      platform: source,
      displayName: source,
      lastUpdate,
      ageMs,
      ageHours: ageMs === null ? null : Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10,
      status: 'quarantined',
      recordCount: 0,
      quarantine: quarantine.sort((a, b) => a.season.localeCompare(b.season)),
    })
  }
  return result
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
  // A window sealed with zero publishable rows (published_rank_count 0, see
  // source-freshness.ts) has no visible row and is not missing.
  const sealedEmptyWindows = new Set(
    watermarkRows
      .filter((row) => typeof row.source === 'string' && row.published_rank_count === 0)
      .map((row) => `${String(row.season_id)}\u0000${row.source as string}`)
  )
  const visibleSourceBoards = [...expectedWindowsByBoard.values()].filter((windows) =>
    windows.every(
      (window) =>
        visibleWindowKeys.has(sourceWindowKey(window.season_id, window.registry_slug)) ||
        sealedEmptyWindows.has(`${window.season_id}\u0000${window.source}`)
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
      publishedRankCount < 0
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
  // A source may be sealed with zero rows, but a publication of nothing proves nothing.
  if (publicationRows.every((row) => row.publishedRankCount === 0)) invalid = true

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

  const isolationQuery = supabase.rpc('arena_publication_source_isolations')

  const [expectedResult, visibleBySeason, watermarkResult, isolationResult] = await Promise.all([
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
    signal ? isolationQuery.abortSignal(signal) : isolationQuery,
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

  let isolations: SourceIsolationRow[] = []
  if (isolationResult.error) {
    if (!MISSING_FUNCTION_CODES.has(isolationResult.error.code ?? '')) {
      console.error('[freshness] source isolation authority failed:', isolationResult.error.message)
      throw new Error('source isolation authority is unavailable')
    }
    // Isolation migration not installed: nothing can be isolated yet.
    console.warn('[freshness] source isolation RPC not installed; reporting no quarantine')
  } else {
    isolations = parseSourceIsolationRows(isolationResult.data)
  }

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

  const platforms = applySourceQuarantine(results, isolations, watermarkRows, now)
  const freshCount = platforms.filter((result) => result.status === 'fresh').length
  const quarantinedCount = platforms.filter((result) => result.status === 'quarantined').length

  const report: FreshnessReport = {
    ok:
      criticalPlatforms.length === 0 &&
      stalePlatforms.length === 0 &&
      unknownPlatforms.length === 0 &&
      quarantinedCount === 0,
    checked_at: new Date(now).toISOString(),
    summary: {
      total: platforms.length,
      fresh: freshCount,
      stale: stalePlatforms.length,
      critical: criticalPlatforms.length,
      unknown: unknownPlatforms.length,
      quarantined: quarantinedCount,
    },
    thresholds: {
      stale_hours: STALE_THRESHOLD_MS / (1000 * 60 * 60),
      critical_hours: CRITICAL_THRESHOLD_MS / (1000 * 60 * 60),
    },
    platforms,
  }

  return {
    report,
    ...deriveFreshnessAuthorityMetadata(expectedWindows, visibleWindows, watermarkRows, now),
  }
}

export async function buildFreshnessReport(signal?: AbortSignal): Promise<FreshnessReport> {
  return (await buildFreshnessAuthoritySnapshot(signal)).report
}
