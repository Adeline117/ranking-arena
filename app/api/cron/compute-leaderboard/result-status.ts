export type ComputeStatus =
  | 'database_finalized'
  | 'checkpoint_skip'
  | 'degradation_skip'
  | 'no_candidates'
  | 'failed'

export interface ComputeResult {
  season: string
  count: number
  error: unknown
  status: ComputeStatus
}

export interface ComputeSeasonOutcome {
  count: number
  status: Exclude<ComputeStatus, 'failed'>
}

/**
 * Status is authoritative. Keep the error check as defense in depth for any
 * future caller that accidentally constructs an inconsistent result object.
 */
export function hasComputeFailures(results: readonly ComputeResult[]): boolean {
  return results.some((result) => result.status === 'failed' || result.error != null)
}

/**
 * Publication authority and cache work is safe only when every requested
 * season completed its live-table database finalization in this invocation. A
 * degradation skip (`count === -1`), empty result, duplicate/missing season,
 * or thrown compute must preserve the existing last-good authority and caches.
 */
export function isCompleteDatabaseFinalizationRun(
  results: readonly ComputeResult[],
  targetSeasons: readonly string[]
): boolean {
  if (targetSeasons.length === 0 || results.length !== targetSeasons.length) return false

  const resultBySeason = new Map(results.map((result) => [result.season, result]))
  if (resultBySeason.size !== targetSeasons.length) return false

  return targetSeasons.every((season) => {
    const result = resultBySeason.get(season)
    return (
      result != null &&
      result.status === 'database_finalized' &&
      result.error == null &&
      result.count > 0
    )
  })
}
