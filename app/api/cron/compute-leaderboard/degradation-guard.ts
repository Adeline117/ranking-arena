/**
 * Degradation guard — prevent bad data from overwriting good leaderboard data.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import type { Database } from '@/lib/supabase/database.types'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { createLogger } from '@/lib/utils/logger'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'

const logger = createLogger('compute-leaderboard')

const DEGRADATION_THRESHOLD = 0.6

interface DegradationResult {
  /** 'proceed' = continue with write, 'skip' = abort and return -1, 'force' = forced past threshold */
  action: 'proceed' | 'skip' | 'force'
}

/**
 * Check if the scored trader count is degraded vs expected.
 * Degradation always preserves last-good unless an operator explicitly forces the write.
 */
export async function checkDegradationGuard(params: {
  supabase: SupabaseClient<Database>
  season: Period
  scoredCount: number
  freshPlatforms: string[]
  forceWrite: boolean
  scoredCountBySource: ReadonlyMap<string, number>
}): Promise<DegradationResult> {
  const { supabase, season, scoredCount, freshPlatforms, forceWrite, scoredCountBySource } = params

  if (forceWrite) {
    logger.warn(`${season}: explicit force write enabled, bypassing degradation checks`)
    return { action: 'force' }
  }

  // Per-source cache rows are the publication authority. A global count can
  // stay healthy while one source collapses and another grows, so it must
  // never authorize destructive per-source cleanup.
  const freshAllowedSources = [
    ...new Set(freshPlatforms.filter((source) => isPublicRankingSourceAllowed(source))),
  ]
  const freshAllowedSet = new Set(freshAllowedSources)
  const expectedCountBySource = new Map<string, number>()
  try {
    const { data: platformCounts, error: platformCountsError } = await supabase.rpc(
      'get_expected_platform_counts',
      { p_season_id: season }
    )
    if (platformCountsError) {
      throw new Error(platformCountsError.message || 'unknown expected-count authority error')
    }
    if (!Array.isArray(platformCounts)) {
      throw new Error('expected-count authority returned a non-array payload')
    }

    const legacyCounts = new Map<string, number>()
    const positiveScoreCounts = new Map<string, number>()
    for (const row of platformCounts) {
      const rawSource = row.source
      if (typeof rawSource !== 'string') continue
      const isPositiveScoreCount = rawSource.endsWith('_gt0')
      const source = isPositiveScoreCount ? rawSource.slice(0, -'_gt0'.length) : rawSource
      if (!freshAllowedSet.has(source)) continue

      const count = row.expected_count
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`invalid expected count for ${rawSource}`)
      }

      const targetCounts = isPositiveScoreCount ? positiveScoreCounts : legacyCounts
      if (targetCounts.has(source)) {
        throw new Error(`duplicate expected count for ${rawSource}`)
      }
      targetCounts.set(source, count)
    }

    const missingSources: string[] = []
    for (const source of freshAllowedSources) {
      // `_gt0` matches the actual arena_score > 0 publication cohort. Legacy
      // rows remain a temporary compatibility authority during cache upgrade.
      const expected = positiveScoreCounts.get(source) ?? legacyCounts.get(source)
      if (expected == null) {
        missingSources.push(source)
      } else {
        expectedCountBySource.set(source, expected)
      }
    }

    if (freshAllowedSources.length === 0) {
      throw new Error('no allowed fresh publication sources')
    }
    if (missingSources.length > 0) {
      throw new Error(`missing per-source baseline for ${missingSources.join(',')}`)
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.error(
      `[${season}] expected-count authority unavailable; preserving last-good leaderboard: ${message}`
    )
    sendRateLimitedAlert(
      {
        title: `Leaderboard ${season} degradation authority unavailable`,
        message: `${season}: expected source counts could not be verified. Data preserved but stale.`,
        level: 'critical',
        details: { season, error: message },
      },
      `leaderboard-degrade-authority:${season}`,
      60 * 60 * 1000
    ).catch(() => {})
    return { action: 'skip' }
  }

  const expectedCount = [...expectedCountBySource.values()].reduce((sum, count) => sum + count, 0)

  const sourceCountEntries = [...scoredCountBySource.entries()]
  const sourceCountsValid = sourceCountEntries.every(
    ([source, count]) =>
      freshAllowedSet.has(source) &&
      expectedCountBySource.has(source) &&
      Number.isSafeInteger(count) &&
      count >= 0
  )
  const sourceCountTotal = sourceCountEntries.reduce((sum, [, count]) => sum + count, 0)
  if (!sourceCountsValid || sourceCountTotal !== scoredCount) {
    logger.error(
      `[${season}] scored source counts disagree with the publication cohort ` +
        `(sources=${sourceCountTotal}, cohort=${scoredCount}); preserving current board`
    )
    sendRateLimitedAlert(
      {
        title: `Leaderboard ${season} degradation count mismatch`,
        message: `${season}: per-source scored counts do not match the publication cohort.`,
        level: 'critical',
        details: { season, scored: scoredCount, sourceCountTotal },
      },
      `leaderboard-degrade-count-mismatch:${season}`,
      60 * 60 * 1000
    ).catch(() => {})
    return { action: 'skip' }
  }

  const ratio = scoredCount / expectedCount
  logger.info(
    `[${season}] Degradation check: scored=${scoredCount}, expected=${expectedCount} (per-source count cache), freshPlatforms=${freshPlatforms.length}, ratio=${(ratio * 100).toFixed(1)}%, threshold=${DEGRADATION_THRESHOLD * 100}%`
  )

  const degradedSources: Array<{
    source: string
    scored: number
    expected: number
    ratio: number
  }> = []
  for (const [source, expected] of expectedCountBySource) {
    const current = scoredCountBySource.get(source) ?? 0
    const sourceRatio = current / expected
    // Per-source cleanup is destructive at every board size. Do not let a
    // small source bypass last-good protection merely because global totals
    // remain healthy.
    if (sourceRatio < DEGRADATION_THRESHOLD) {
      degradedSources.push({ source, scored: current, expected, ratio: sourceRatio })
    }
  }

  const globallyDegraded =
    expectedCount > 500 && (scoredCount < 500 || ratio < DEGRADATION_THRESHOLD)
  if (globallyDegraded || degradedSources.length > 0) {
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

    logger.error(
      `${season}: computed ${scoredCount} traders (expected: ${expectedCount}, ratio: ${(ratio * 100).toFixed(1)}%). ` +
        `SKIPPING — degraded sources=${degradedSources.map(({ source }) => source).join(',') || 'none'} ` +
        `(consecutive skip ${consecutiveSkips}).`
    )
    sendRateLimitedAlert(
      {
        title: `Leaderboard ${season} degradation skip ${consecutiveSkips}`,
        message: `${season}: ${scoredCount}/${expectedCount} traders (${(ratio * 100).toFixed(1)}%). Data preserved but stale.`,
        level: consecutiveSkips >= 2 ? 'critical' : 'warning',
        details: {
          season,
          scored: scoredCount,
          expected: expectedCount,
          ratio,
          skip: consecutiveSkips,
          degradedSources,
        },
      },
      `leaderboard-degrade:${season}`,
      60 * 60 * 1000
    ).catch((err) =>
      logger.warn(
        `[compute-leaderboard] Degradation alert failed: ${err instanceof Error ? err.message : String(err)}`
      )
    )

    // Preserve the complete last-good board byte-for-byte. A degraded read
    // must not upsert, rerank, zero, or clean rows merely because it repeated.
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
