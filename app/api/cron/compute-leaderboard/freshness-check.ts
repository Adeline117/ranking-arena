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
import { SOURCES_WITH_DATA } from '@/lib/constants/exchanges'
import type { Period } from '@/lib/utils/arena-score'
import {
  buildSourceFreshnessStatuses,
  RANKING_SOURCE_FUTURE_TOLERANCE_MS,
  RANKING_SOURCE_STALE_MS,
  type SourceFreshnessRow,
} from '@/lib/rankings/source-freshness'
import type { TraderRow } from './trader-row'

export interface FreshnessResult {
  freshPlatforms: string[]
  stalePlatforms: string[]
  queryFailedPlatforms: string[]
}

/**
 * Classify every source in SOURCES_WITH_DATA as fresh / stale / query-failed.
 * Falls back to a per-platform DB probe when traderMap has no rows for that
 * source — that probe is what catches "Phase 1 query timeout" vs "platform
 * really has no recent data".
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

  // One small source-level query replaces the old per-source probe against
  // leaderboard_ranks.computed_at. A score job timestamp is never evidence
  // that the underlying exchange snapshot is fresh.
  const { data: persistedWatermarks, error: watermarkError } = await supabase
    .from('leaderboard_source_freshness')
    .select('source,source_as_of')
    .eq('season_id', season)
  const watermarkRows = (persistedWatermarks || []) as SourceFreshnessRow[]

  for (const source of SOURCES_WITH_DATA) {
    const sourceTraders = Array.from(traderMap.values()).filter((t) => t.source === source)
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

  return { freshPlatforms, stalePlatforms, queryFailedPlatforms }
}
