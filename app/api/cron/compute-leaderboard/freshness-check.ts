/**
 * compute-leaderboard / freshness-check
 *
 * Per-platform 48h freshness gate. Extracted from route.ts as part of the
 * computeSeason main-loop split (TASKS.md "Open follow-ups").
 *
 * The gate distinguishes three cases per platform:
 *   • Has data in traderMap → use its conservative source_board_as_of
 *   • No data in traderMap but DB has fresh rows → query-failed, retry next cron
 *   • No data anywhere → truly stale
 *
 * The caller decides whether to throw — we just classify.
 */

import { getSupabaseAdmin } from '@/lib/api'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import type { Period } from '@/lib/utils/arena-score'
import {
  buildSourceFreshnessStatuses,
  parseExpectedSourceWindows,
  RANKING_SOURCE_FUTURE_TOLERANCE_MS,
  RANKING_SOURCE_STALE_MS,
  type SourceFreshnessRow,
} from '@/lib/rankings/source-freshness'
import type { TraderRow } from './trader-row'

export interface FreshnessResult {
  expectedPlatforms: string[]
  freshPlatforms: string[]
  stalePlatforms: string[]
  queryFailedPlatforms: string[]
}

/**
 * Classify every active+serving source declared for this season as fresh /
 * stale / query-failed. Registry promises are the membership authority; a
 * historical TypeScript list must never silently exclude a newly serving
 * source from scoring, cleanup, and watermark publication.
 */
export async function checkPlatformFreshness(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
  season: Period
): Promise<FreshnessResult> {
  const now = Date.now()
  const freshPlatforms: string[] = []
  const stalePlatforms: string[] = []
  const queryFailedPlatforms: string[] = []

  const [expectedResult, watermarkResult] = await Promise.all([
    supabase.rpc('arena_freshness_expected_sources'),
    // One small source-level query replaces the old per-source probe against
    // leaderboard_ranks.computed_at. A score job timestamp is never evidence
    // that the underlying exchange snapshot is fresh.
    supabase
      .from('leaderboard_source_freshness')
      .select('source,source_as_of')
      .eq('season_id', season),
  ])

  if (expectedResult.error) {
    throw new Error(`[${season}] freshness expected-source authority is unavailable`)
  }
  const expectedPlatforms = [
    ...new Set(
      parseExpectedSourceWindows(expectedResult.data)
        .filter((row) => row.season_id === season)
        .map((row) => row.source)
    ),
  ].sort()
  if (expectedPlatforms.length === 0) {
    throw new Error(`[${season}] freshness expected-source authority returned no season rows`)
  }

  const unconfigured = expectedPlatforms.filter(
    (source) => !Object.prototype.hasOwnProperty.call(EXCHANGE_CONFIG, source)
  )
  if (unconfigured.length > 0) {
    throw new Error(
      `[${season}] expected ranking sources lack exchange configuration: ${unconfigured.join(', ')}`
    )
  }

  const tradersBySource = new Map<string, TraderRow[]>()
  for (const trader of traderMap.values()) {
    const rows = tradersBySource.get(trader.source) ?? []
    rows.push(trader)
    tradersBySource.set(trader.source, rows)
  }
  const expectedSet = new Set(expectedPlatforms)
  const unexpectedLoaded = [...tradersBySource.keys()]
    .filter((source) => !expectedSet.has(source))
    .sort()
  if (unexpectedLoaded.length > 0) {
    throw new Error(
      `[${season}] score inputs contain sources outside the registry authority: ${unexpectedLoaded.join(', ')}`
    )
  }

  const persistedWatermarks = watermarkResult.data
  const watermarkError = watermarkResult.error
  const watermarkRows = (persistedWatermarks || []) as SourceFreshnessRow[]

  for (const source of expectedPlatforms) {
    const sourceTraders = tradersBySource.get(source) ?? []
    if (sourceTraders.length > 0) {
      const boardTimestamps = sourceTraders.map((trader) => Date.parse(trader.source_board_as_of))
      const hasInvalidBoard = boardTimestamps.some((timestamp) => !Number.isFinite(timestamp))
      // A mixed source board is only as fresh as its oldest row. Using max()
      // would let one newly published row hide an older partial board.
      const oldestBoard = hasInvalidBoard ? Number.NaN : Math.min(...boardTimestamps)
      if (
        !Number.isFinite(oldestBoard) ||
        oldestBoard > now + RANKING_SOURCE_FUTURE_TOLERANCE_MS ||
        now - oldestBoard > RANKING_SOURCE_STALE_MS
      ) {
        stalePlatforms.push(source)
      } else {
        freshPlatforms.push(source)
      }
      continue
    }

    // traderMap empty for this source — a fresh last-good source watermark
    // means this run failed to load it; an old/missing watermark means the
    // source is genuinely stale. If the watermark query itself failed, fail
    // closed as query-failed so the caller preserves the prior leaderboard.
    if (watermarkError) {
      queryFailedPlatforms.push(source)
      continue
    }
    const persisted = buildSourceFreshnessStatuses(watermarkRows, [source], now)[0]
    if (persisted && !persisted.is_stale) {
      queryFailedPlatforms.push(source)
    } else {
      stalePlatforms.push(source)
    }
  }

  return { expectedPlatforms, freshPlatforms, stalePlatforms, queryFailedPlatforms }
}
