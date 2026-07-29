import type { getSupabaseAdmin } from '@/lib/api'
import {
  readLeaderboardPublicationProofs,
  type ReadPublicationProofsInput,
  type ReadPublicationProofsOptions,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'

type PublicationProofClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

export class SealedRankingGenerationChangedError extends Error {
  constructor() {
    super('sealed leaderboard generation changed while it was being read')
    this.name = 'SealedRankingGenerationChangedError'
  }
}

export interface SealedRankingGenerationRead<T> {
  readonly value: T
  readonly publication: SealedLeaderboardPublicationProofSet
  readonly publicationIdentity: string
}

/**
 * Canonical, complete identity for a validated proof set.
 *
 * `readLeaderboardPublicationProofs` freezes the set, sorts the requested
 * sources, and emits every proof with one exact property order. Comparing this
 * identity therefore compares the cohort, source membership, mutation fences,
 * counts, digests, timestamps, and sealed flags together.
 */
export function sealedRankingPublicationIdentity(
  publication: SealedLeaderboardPublicationProofSet
): string {
  return JSON.stringify(publication)
}

/**
 * Authorize one ranking read against a stable sealed generation.
 *
 * The reader must bind its leaderboard_ranks query to
 * `publication.scoreCohortId`. The second proof read closes the race with an
 * atomic generation cutover: a result is returned only when the complete proof
 * set is byte-for-byte identical before and after the data query.
 */
export async function readSealedRankingGeneration<T>(
  supabase: PublicationProofClient,
  input: ReadPublicationProofsInput,
  reader: (publication: SealedLeaderboardPublicationProofSet) => Promise<T>,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedRankingGenerationRead<T>> {
  const authorizationClock = options.now ?? new Date(Date.now())
  const proofOptions = { ...options, now: authorizationClock }
  const before = await readLeaderboardPublicationProofs(supabase, input, proofOptions)
  const beforeIdentity = sealedRankingPublicationIdentity(before)
  const value = await reader(before)
  const after = await readLeaderboardPublicationProofs(supabase, input, proofOptions)

  if (sealedRankingPublicationIdentity(after) !== beforeIdentity) {
    throw new SealedRankingGenerationChangedError()
  }

  return Object.freeze({
    value,
    publication: before,
    publicationIdentity: beforeIdentity,
  })
}
