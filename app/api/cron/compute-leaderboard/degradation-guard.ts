/**
 * Degradation guard — prevent bad data from overwriting good leaderboard data.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { cleanupStaleRows } from './rerank-cleanup'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

const DEGRADATION_THRESHOLD = 0.6

interface DegradationResult {
  /** 'proceed' = continue with write, 'skip' = abort and return -1, 'force' = forced past threshold */
  action: 'proceed' | 'skip' | 'force'
}

/**
 * Check if the scored trader count is degraded vs expected.
 * If degradation detected and not force-write, may skip or force-compute after consecutive skips.
 */
export async function checkDegradationGuard(params: {
  supabase: SupabaseClient
  season: Period
  scoredCount: number
  freshPlatforms: string[]
  forceWrite: boolean
  previousCount?: number
}): Promise<DegradationResult> {
  const { supabase, season, scoredCount, freshPlatforms, forceWrite, previousCount } = params
  const LAST_SCORED_KEY = `leaderboard:last-scored-count:${season}`

  // Compute expected count from per-platform known counts
  let expectedCount = 0
  let expectedSource = 'per-platform'
  try {
    const { data: platformCounts } = await (supabase as any).rpc('get_expected_platform_counts', {
      p_season_id: season,
    })
    if (platformCounts && Array.isArray(platformCounts)) {
      const freshSet = new Set(freshPlatforms)
      for (const row of platformCounts) {
        const src = row.source as string
        const cnt = Number(row.expected_count) || 0
        if (freshSet.has(src)) {
          expectedCount += cnt
        }
      }
    }
  } catch (e) {
    logger.warn(
      `[${season}] get_expected_platform_counts failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  // Fallback: pipeline_state baseline
  if (expectedCount === 0) {
    expectedSource = 'pipeline-state-fallback'
    try {
      const stored = await PipelineState.get<number>(LAST_SCORED_KEY)
      if (stored && typeof stored === 'number' && stored > 0) {
        expectedCount = stored
      } else if (previousCount && previousCount > 0) {
        expectedCount = Math.round(previousCount * 0.6)
        expectedSource = 'table-count-discounted'
      }
    } catch (e) {
      logger.warn(
        `[${season}] pipeline_state fallback failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  const MAX_CONSECUTIVE_SKIPS = 1
  const ratio = expectedCount ? scoredCount / expectedCount : 1
  logger.info(
    `[${season}] Degradation check: scored=${scoredCount}, expected=${expectedCount} (${expectedSource}), freshPlatforms=${freshPlatforms.length}, ratio=${(ratio * 100).toFixed(1)}%, threshold=${DEGRADATION_THRESHOLD * 100}%`
  )

  if (forceWrite) {
    logger.warn(
      `${season}: force write enabled, skipping degradation check (scored: ${scoredCount}, expected: ${expectedCount})`
    )
    return { action: 'force' }
  }

  if (expectedCount && expectedCount > 500) {
    if (scoredCount < 500 || ratio < DEGRADATION_THRESHOLD) {
      let consecutiveSkips = 0
      const skipKey = `leaderboard:degradation-skips:${season}`
      try {
        const stored = await PipelineState.get<number>(skipKey)
        consecutiveSkips = (typeof stored === 'number' ? stored : 0) + 1
        await PipelineState.set(skipKey, consecutiveSkips)
      } catch (e) {
        logger.warn(
          `[${season}] skip counter DB failure: ${e instanceof Error ? e.message : String(e)}`
        )
      }

      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        logger.warn(
          `${season}: degradation detected (${scoredCount}/${expectedCount}, ${(ratio * 100).toFixed(1)}%) but FORCE-COMPUTING after ${consecutiveSkips} consecutive skips`
        )
        try {
          await PipelineState.del(skipKey)
        } catch {
          /* non-critical */
        }
        return { action: 'force' }
      }

      // Skip path
      logger.error(
        `${season}: computed ${scoredCount} traders (expected: ${expectedCount}, ratio: ${(ratio * 100).toFixed(1)}%). SKIPPING — below ${DEGRADATION_THRESHOLD * 100}% threshold (skip ${consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}).`
      )
      sendRateLimitedAlert(
        {
          title: `Leaderboard ${season} degradation skip ${consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}`,
          message: `${season}: ${scoredCount}/${expectedCount} traders (${(ratio * 100).toFixed(1)}%). Data preserved but stale.`,
          level: consecutiveSkips >= 2 ? 'critical' : 'warning',
          details: {
            season,
            scored: scoredCount,
            expected: expectedCount,
            ratio,
            skip: consecutiveSkips,
          },
        },
        `leaderboard-degrade:${season}`,
        60 * 60 * 1000
      ).catch((err) =>
        logger.warn(
          `[compute-leaderboard] Degradation alert failed: ${err instanceof Error ? err.message : String(err)}`
        )
      )

      // Still run stale-row cleanup even on degradation skip
      try {
        const cleaned = await cleanupStaleRows(supabase, season)
        if (cleaned > 0)
          logger.info(`${season}: cleaned ${cleaned} stale rows despite degradation skip`)
      } catch (cleanupErr) {
        logger.warn(
          `${season}: cleanup-on-degradation failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
        )
      }

      return { action: 'skip' }
    }
  }

  // Reset skip counter on successful pass
  try {
    await PipelineState.del(`leaderboard:degradation-skips:${season}`)
  } catch {
    /* non-critical */
  }

  return { action: 'proceed' }
}

/**
 * Save the scored count for future degradation checks.
 */
export async function saveScoredCount(season: Period, count: number): Promise<void> {
  const key = `leaderboard:last-scored-count:${season}`
  try {
    await PipelineState.set(key, count)
  } catch {
    /* non-critical */
  }
}
