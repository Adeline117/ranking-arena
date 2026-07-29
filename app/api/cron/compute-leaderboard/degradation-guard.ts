/**
 * Degradation guard — prevent bad data from overwriting good leaderboard data.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

const DEGRADATION_THRESHOLD = 0.6

interface DegradationResult {
  /** 'proceed' = continue with write, 'skip' = abort and return -1, 'force' = forced past threshold */
  action: 'proceed' | 'skip' | 'force'
}

/**
 * Check if the scored trader count is degraded vs expected.
 * Automatic runs always preserve the last-good leaderboard when degradation is
 * detected. Only the authenticated cron route's explicit `force=1` override may
 * bypass this guard.
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
    const { data: platformCounts, error: platformCountsError } = await (supabase as any).rpc(
      'get_expected_platform_counts',
      {
        p_season_id: season,
      }
    )
    if (platformCountsError) {
      throw new Error(
        `get_expected_platform_counts returned an error: ${platformCountsError.message ?? String(platformCountsError)}`
      )
    }
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

  // Fallback: pipeline_state baseline, then the last published table count.
  // previousCount is already the baseline; discounting it here and then applying
  // the 60% threshold again would silently lower the guard to 36%.
  if (expectedCount === 0) {
    expectedSource = 'pipeline-state-fallback'
    try {
      const stored = await PipelineState.get<number>(LAST_SCORED_KEY)
      if (stored && typeof stored === 'number' && stored > 0) {
        expectedCount = stored
      }
    } catch (e) {
      logger.warn(
        `[${season}] pipeline_state fallback failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    if (expectedCount === 0 && previousCount && previousCount > 0) {
      expectedCount = previousCount
      expectedSource = 'table-count'
    }
  }

  const expectedKnown = expectedCount > 0
  const ratio = expectedKnown ? scoredCount / expectedCount : null
  logger.info(
    `[${season}] Degradation check: scored=${scoredCount}, expected=${expectedKnown ? expectedCount : 'unknown'} (${expectedSource}), freshPlatforms=${freshPlatforms.length}, ratio=${ratio === null ? 'unknown' : `${(ratio * 100).toFixed(1)}%`}, threshold=${DEGRADATION_THRESHOLD * 100}%`
  )

  if (forceWrite) {
    logger.warn(
      `${season}: force write enabled, skipping degradation check (scored: ${scoredCount}, expected: ${expectedCount})`
    )
    return { action: 'force' }
  }

  // A positive result is not proof of completeness. If every independent
  // baseline is unavailable, publishing would let a partially collapsed cohort
  // become the new source of truth. Preserve the last-good generation instead.
  const degraded = !expectedKnown || (ratio !== null && ratio < DEGRADATION_THRESHOLD)
  if (degraded) {
    let consecutiveSkips = 1
    const skipKey = `leaderboard:degradation-skips:${season}`
    try {
      const stored = await PipelineState.get<number>(skipKey)
      consecutiveSkips = (typeof stored === 'number' && stored >= 0 ? stored : 0) + 1
      await PipelineState.set(skipKey, consecutiveSkips)
    } catch (e) {
      logger.warn(
        `[${season}] skip counter DB failure: ${e instanceof Error ? e.message : String(e)}`
      )
    }

    const expectedLabel = expectedKnown ? String(expectedCount) : 'unknown'
    const ratioLabel = ratio === null ? 'unknown' : `${(ratio * 100).toFixed(1)}%`
    logger.error(
      `${season}: computed ${scoredCount} traders (expected: ${expectedLabel}, ratio: ${ratioLabel}). SKIPPING — automatic degradation may never mutate the last-good leaderboard (consecutive skip ${consecutiveSkips}).`
    )
    sendRateLimitedAlert(
      {
        title: `Leaderboard ${season} degradation skip ${consecutiveSkips}`,
        message: `${season}: ${scoredCount}/${expectedLabel} traders (${ratioLabel}). Data preserved but stale.`,
        level: consecutiveSkips >= 2 ? 'critical' : 'warning',
        details: {
          season,
          scored: scoredCount,
          expected: expectedKnown ? expectedCount : null,
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

    // A degradation skip is a strict no-op for leaderboard data. In particular,
    // do not run cleanup: its freshness evidence may be part of the same bad run.
    return { action: 'skip' }
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
