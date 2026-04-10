/**
 * compute-leaderboard / freshness-check
 *
 * Per-platform 48h freshness gate. Extracted from route.ts as part of the
 * computeSeason main-loop split (TASKS.md "Open follow-ups").
 *
 * The gate distinguishes three cases per platform:
 *   • Has data in traderMap → use latest captured_at
 *   • No data in traderMap but DB has fresh rows → query-failed, retry next cron
 *   • No data anywhere → truly stale
 *
 * The caller decides whether to throw — we just classify.
 */

import { getSupabaseAdmin } from '@/lib/api'
import { SOURCES_WITH_DATA } from '@/lib/constants/exchanges'
import type { TraderRow } from './trader-row'

export interface FreshnessResult {
  freshPlatforms: string[]
  stalePlatforms: string[]
  queryFailedPlatforms: string[]
}

const STALE_THRESHOLD_MS = 48 * 3600 * 1000

/**
 * Classify every source in SOURCES_WITH_DATA as fresh / stale / query-failed.
 * Falls back to a per-platform DB probe when traderMap has no rows for that
 * source — that probe is what catches "Phase 1 query timeout" vs "platform
 * really has no recent data".
 */
export async function checkPlatformFreshness(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traderMap: Map<string, TraderRow>,
): Promise<FreshnessResult> {
  const now = Date.now()
  const freshPlatforms: string[] = []
  const stalePlatforms: string[] = []
  const queryFailedPlatforms: string[] = []

  for (const source of SOURCES_WITH_DATA) {
    const sourceTraders = Array.from(traderMap.values()).filter(t => t.source === source)
    if (sourceTraders.length > 0) {
      const latestCaptured = Math.max(...sourceTraders.map(t => new Date(t.captured_at).getTime()))
      if (now - latestCaptured > STALE_THRESHOLD_MS) {
        stalePlatforms.push(source)
      } else {
        freshPlatforms.push(source)
      }
      continue
    }
    // traderMap empty for this source — check DB directly to distinguish
    // "query failed" (retry later) from "actually stale" (really no data)
    try {
      const { data: dbCheck } = await supabase
        .from('trader_snapshots_v2')
        .select('updated_at')
        .eq('platform', source)
        .gte('updated_at', new Date(now - STALE_THRESHOLD_MS).toISOString())
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (dbCheck) {
        // DB has fresh data but we failed to load it — query-failed, not stale
        queryFailedPlatforms.push(source)
      } else {
        stalePlatforms.push(source)
      }
    } catch {
      queryFailedPlatforms.push(source)
    }
  }

  return { freshPlatforms, stalePlatforms, queryFailedPlatforms }
}
