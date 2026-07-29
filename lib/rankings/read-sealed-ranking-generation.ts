import type { getSupabaseAdmin } from '@/lib/api'
import { readLeaderboardPublicationAuthority } from '@/lib/rankings/read-publication-authority'
import {
  canonicalizePublicationProofInput,
  readLeaderboardPublicationProofs,
  type LeaderboardPublicationSeason,
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

export class SealedRankingSourceOutsideAuthorityError extends Error {
  constructor(public readonly source: string) {
    super(`requested ranking source is outside the season authority: ${source}`)
    this.name = 'SealedRankingSourceOutsideAuthorityError'
  }
}

export interface SealedRankingGenerationRead<T> {
  readonly value: T
  readonly publication: SealedLeaderboardPublicationProofSet
  readonly publicationIdentity: string
}

export interface SealedRankingAuthorityRead<T> extends SealedRankingGenerationRead<T> {
  /** Complete dynamic season proof set used for both generation fences. */
  readonly authorityPublication: SealedLeaderboardPublicationProofSet
  readonly authorityPublicationIdentity: string
  readonly authoritySources: readonly string[]
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

function scopePublication(
  authorityPublication: SealedLeaderboardPublicationProofSet,
  requestedSources: readonly string[] | undefined
): SealedLeaderboardPublicationProofSet {
  if (requestedSources === undefined) return authorityPublication

  const proofsBySource = new Map(
    authorityPublication.proofs.map((proof) => [proof.source, proof] as const)
  )
  const proofs = requestedSources.map((source) => {
    const proof = proofsBySource.get(source)
    if (!proof) throw new SealedRankingSourceOutsideAuthorityError(source)
    return proof
  })

  if (proofs.length === authorityPublication.proofs.length) {
    return authorityPublication
  }
  return Object.freeze({
    state: 'sealed',
    season: authorityPublication.season,
    scoreCohortId: authorityPublication.scoreCohortId,
    proofs: Object.freeze(proofs),
  })
}

async function readStableAuthorityGeneration<T>(
  supabase: PublicationProofClient,
  season: LeaderboardPublicationSeason,
  requestedSources: readonly string[] | undefined,
  reader: (publication: SealedLeaderboardPublicationProofSet) => Promise<T>,
  options: ReadPublicationProofsOptions
): Promise<SealedRankingAuthorityRead<T>> {
  const authorizationClock = options.now ?? new Date(Date.now())
  const proofOptions = { ...options, now: authorizationClock }

  const beforeAuthoritySources = await readLeaderboardPublicationAuthority(
    supabase,
    season,
    proofOptions
  )
  // Reject an unknown requested source before asking the proof RPC to seal the
  // complete authority. The data reader must never receive an invented scope.
  const requestedPublicationSources =
    requestedSources === undefined
      ? undefined
      : requestedSources.map((source) => {
          if (!beforeAuthoritySources.includes(source)) {
            throw new SealedRankingSourceOutsideAuthorityError(source)
          }
          return source
        })
  const before = await readLeaderboardPublicationProofs(
    supabase,
    { season, sources: beforeAuthoritySources },
    proofOptions
  )
  const beforeIdentity = sealedRankingPublicationIdentity(before)
  const publication = scopePublication(before, requestedPublicationSources)
  const value = await reader(publication)

  const afterAuthoritySources = await readLeaderboardPublicationAuthority(
    supabase,
    season,
    proofOptions
  )
  const after = await readLeaderboardPublicationProofs(
    supabase,
    { season, sources: afterAuthoritySources },
    proofOptions
  )

  if (sealedRankingPublicationIdentity(after) !== beforeIdentity) {
    throw new SealedRankingGenerationChangedError()
  }

  return Object.freeze({
    value,
    publication,
    // Preserve the scoped identity consumed by existing cache envelopes.
    // Callers that fence season-global or multi-season data must use the
    // explicitly exposed complete authority identity below.
    publicationIdentity: sealedRankingPublicationIdentity(publication),
    authorityPublication: before,
    authorityPublicationIdentity: beforeIdentity,
    authoritySources: beforeAuthoritySources,
  })
}

/**
 * Authorize one ranking read against a stable sealed generation.
 *
 * The reader must bind its leaderboard_ranks query to
 * `publication.scoreCohortId`. The second proof read closes the race with an
 * atomic generation cutover. The SQL proof RPC always receives the complete
 * dynamic season authority; `input.sources` only scopes the immutable proof set
 * given to the data reader.
 */
export async function readSealedRankingGeneration<T>(
  supabase: PublicationProofClient,
  input: ReadPublicationProofsInput,
  reader: (publication: SealedLeaderboardPublicationProofSet) => Promise<T>,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedRankingAuthorityRead<T>> {
  const canonicalInput = canonicalizePublicationProofInput(input)
  return readStableAuthorityGeneration(
    supabase,
    canonicalInput.season,
    canonicalInput.sources,
    reader,
    options
  )
}

/**
 * Authorize a read over every source in the dynamic authority for one season.
 *
 * Use this instead of a TypeScript source registry for global leaderboards,
 * exports, and multi-season generation fences.
 */
export async function readSealedRankingAuthorityGeneration<T>(
  supabase: PublicationProofClient,
  season: LeaderboardPublicationSeason,
  reader: (publication: SealedLeaderboardPublicationProofSet) => Promise<T>,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedRankingAuthorityRead<T>> {
  const canonicalSeason = canonicalizePublicationProofInput({
    season,
    sources: ['authority'],
  }).season
  return readStableAuthorityGeneration(supabase, canonicalSeason, undefined, reader, options)
}
