export interface ComputeResult {
  season: string
  count: number
  error: unknown
}

/**
 * A count of -1 is a degradation skip when no error accompanies it. A
 * successful zero-row result is never healthy for a whole leaderboard season:
 * accepting it would let an empty public cohort be reported as a successful
 * core ranking run.
 */
export function hasComputeFailures(results: readonly ComputeResult[]): boolean {
  return results.some((result) => result.error != null || result.count === 0)
}
