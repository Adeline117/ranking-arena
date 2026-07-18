export interface ComputeResult {
  season: string
  count: number
  error: unknown
}

/**
 * A count of -1 is overloaded by the compute loop: it can mean either a
 * degradation skip or a thrown computation failure. The error field is the
 * only authoritative discriminator.
 */
export function hasComputeFailures(results: readonly ComputeResult[]): boolean {
  return results.some((result) => result.error != null)
}
