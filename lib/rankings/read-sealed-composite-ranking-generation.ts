import type { getSupabaseAdmin } from '@/lib/api'
import { readLeaderboardPublicationAuthority } from '@/lib/rankings/read-publication-authority'
import {
  readLeaderboardPublicationProofs,
  type LeaderboardPublicationSeason,
  type ReadPublicationProofsOptions,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import { SealedRankingGenerationChangedError } from '@/lib/rankings/read-sealed-ranking-generation'

type PublicationProofClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

export const COMPOSITE_RANKING_SEASONS = ['7D', '30D', '90D'] as const satisfies readonly [
  LeaderboardPublicationSeason,
  LeaderboardPublicationSeason,
  LeaderboardPublicationSeason,
]

export interface SealedCompositeRankingPublicationSet {
  readonly state: 'sealed'
  readonly publications: readonly [
    SealedLeaderboardPublicationProofSet,
    SealedLeaderboardPublicationProofSet,
    SealedLeaderboardPublicationProofSet,
  ]
}

export interface SealedCompositeRankingGenerationRead<T> {
  readonly value: T
  readonly publication: SealedCompositeRankingPublicationSet
  readonly publicationIdentity: string
}

function compositePublicationSet(
  publications: readonly SealedLeaderboardPublicationProofSet[]
): SealedCompositeRankingPublicationSet {
  if (
    publications.length !== COMPOSITE_RANKING_SEASONS.length ||
    publications.some(
      (publication, index) => publication.season !== COMPOSITE_RANKING_SEASONS[index]
    )
  ) {
    throw new TypeError('composite ranking publications must be ordered 7D, 30D, 90D')
  }

  return Object.freeze({
    state: 'sealed',
    publications: Object.freeze([
      publications[0],
      publications[1],
      publications[2],
    ]) as SealedCompositeRankingPublicationSet['publications'],
  })
}

export function sealedCompositeRankingPublicationIdentity(
  publication: SealedCompositeRankingPublicationSet
): string {
  return JSON.stringify(publication)
}

async function readAuthorityPublications(
  supabase: PublicationProofClient,
  options: ReadPublicationProofsOptions
): Promise<SealedCompositeRankingPublicationSet> {
  const publications = await Promise.all(
    COMPOSITE_RANKING_SEASONS.map(async (season) => {
      const sources = await readLeaderboardPublicationAuthority(supabase, season, options)
      return readLeaderboardPublicationProofs(supabase, { season, sources }, options)
    })
  )
  return compositePublicationSet(publications)
}

/**
 * Read one value across a stable cut of all three public ranking generations.
 *
 * Every season uses its complete dynamic source authority and exact sealed
 * cohort. All opening proofs finish before the reader starts; all closing
 * proofs start after it finishes. A change to any authority, cohort, mutation
 * fence, count, digest, or watermark rejects the combined value.
 */
export async function readSealedCompositeRankingGeneration<T>(
  supabase: PublicationProofClient,
  reader: (publication: SealedCompositeRankingPublicationSet) => Promise<T>,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedCompositeRankingGenerationRead<T>> {
  if (typeof reader !== 'function') {
    throw new TypeError('composite ranking reader must be a function')
  }

  const authorizationClock = options.now ?? new Date(Date.now())
  const proofOptions = { ...options, now: authorizationClock }
  const before = await readAuthorityPublications(supabase, proofOptions)
  const beforeIdentity = sealedCompositeRankingPublicationIdentity(before)
  const value = await reader(before)
  const after = await readAuthorityPublications(supabase, proofOptions)

  if (sealedCompositeRankingPublicationIdentity(after) !== beforeIdentity) {
    throw new SealedRankingGenerationChangedError()
  }

  return Object.freeze({
    value,
    publication: before,
    publicationIdentity: beforeIdentity,
  })
}
