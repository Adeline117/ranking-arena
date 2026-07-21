import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  parseVisibleLeaderboardSources,
  type LeaderboardTimeRange,
} from '@/lib/data/visible-leaderboard-sources'
import {
  buildRegistrySourceFreshnessStatuses,
  parseExpectedSourceWindows,
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

/**
 * Load the launch freshness authority shared by cron, admin, and public health.
 *
 * Registry promises, current-generation visibility, and upstream watermarks
 * are independent authorities. Keeping all three prevents one recent source
 * from hiding a missing or stale source/window behind a global MAX timestamp.
 */
export async function buildFreshnessReport(): Promise<FreshnessReport> {
  const supabase = getSupabaseAdmin()
  const now = Date.now()

  const [expectedResult, visibleBySeason, watermarkResult] = await Promise.all([
    supabase.rpc('arena_freshness_expected_sources'),
    Promise.all(
      RANKING_SEASONS.map(async (season) => ({
        season,
        result: await supabase.rpc('arena_visible_sources', {
          p_season_id: season,
        }),
      }))
    ),
    supabase
      .from('leaderboard_source_freshness')
      .select('season_id,source,source_as_of')
      .in('season_id', [...RANKING_SEASONS]),
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
  if (watermarkResult.error || !Array.isArray(watermarkResult.data)) {
    throw new Error('source watermark freshness authority is unavailable')
  }

  const sourceStatuses = buildRegistrySourceFreshnessStatuses(
    expectedWindows,
    visibleWindows,
    watermarkResult.data,
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

  return {
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
}
