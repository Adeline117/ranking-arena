import type { getSupabaseAdmin } from '@/lib/api'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readLeaderboardPublicationAuthority } from '@/lib/rankings/read-publication-authority'
import {
  readLeaderboardPublicationProofs,
  type LeaderboardPublicationSeason,
  type ReadPublicationProofsOptions,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import { sealedRankingPublicationIdentity } from '@/lib/rankings/read-sealed-ranking-generation'

type PublicationProofClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

export const COMPOSITE_PUBLICATION_SEASONS = Object.freeze([
  '7D',
  '30D',
  '90D',
] as const satisfies readonly LeaderboardPublicationSeason[])

export class SealedCompositeGenerationChangedError extends Error {
  constructor() {
    super('sealed composite leaderboard generation changed while it was being read')
    this.name = 'SealedCompositeGenerationChangedError'
  }
}

export interface SealedCompositePublicationFence {
  readonly publications: Readonly<
    Record<LeaderboardPublicationSeason, SealedLeaderboardPublicationProofSet>
  >
  readonly publicationIdentity: string
  sourcesFor(season: LeaderboardPublicationSeason): readonly string[]
  publicationFor(season: LeaderboardPublicationSeason): SealedLeaderboardPublicationProofSet
  verifyStillCurrent(): Promise<void>
}

interface CompositePublicationSnapshot {
  readonly publications: Readonly<
    Record<LeaderboardPublicationSeason, SealedLeaderboardPublicationProofSet>
  >
  readonly sourcesBySeason: Readonly<Record<LeaderboardPublicationSeason, readonly string[]>>
}

function identityFor(snapshot: CompositePublicationSnapshot): string {
  return JSON.stringify(
    COMPOSITE_PUBLICATION_SEASONS.map((season) => {
      return [
        season,
        snapshot.sourcesBySeason[season],
        sealedRankingPublicationIdentity(snapshot.publications[season]),
      ]
    })
  )
}

async function readAllPublications(
  client: PublicationProofClient,
  options: ReadPublicationProofsOptions
): Promise<CompositePublicationSnapshot> {
  const publications = {} as Record<
    LeaderboardPublicationSeason,
    SealedLeaderboardPublicationProofSet
  >
  const sourcesBySeason = {} as Record<LeaderboardPublicationSeason, readonly string[]>

  for (const season of COMPOSITE_PUBLICATION_SEASONS) {
    const sources = await readLeaderboardPublicationAuthority(client, season, options)
    if (sources.some((source) => !isPublicRankingSourceAllowed(source))) {
      throw new Error(`Composite ${season} authority contains a non-public source`)
    }
    sourcesBySeason[season] = Object.freeze([...sources])
    publications[season] = await readLeaderboardPublicationProofs(
      client,
      { season, sources },
      options
    )
  }

  return Object.freeze({
    publications: Object.freeze(publications),
    sourcesBySeason: Object.freeze(sourcesBySeason),
  })
}

/**
 * Freeze the three public leaderboard publications used to build a composite
 * cache. Callers read rows using each returned score cohort, finish every
 * supporting read, then call verifyStillCurrent immediately before publishing.
 */
export async function readSealedCompositePublicationFence(
  client: PublicationProofClient,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedCompositePublicationFence> {
  const authorizationClock = options.now ?? new Date(Date.now())
  const proofOptions = Object.freeze({ ...options, now: authorizationClock })
  const snapshot = await readAllPublications(client, proofOptions)
  const publicationIdentity = identityFor(snapshot)

  return Object.freeze({
    publications: snapshot.publications,
    publicationIdentity,
    sourcesFor(season: LeaderboardPublicationSeason) {
      return snapshot.sourcesBySeason[season]
    },
    publicationFor(season: LeaderboardPublicationSeason) {
      return snapshot.publications[season]
    },
    async verifyStillCurrent() {
      const current = await readAllPublications(client, proofOptions)
      if (identityFor(current) !== publicationIdentity) {
        throw new SealedCompositeGenerationChangedError()
      }
    },
  })
}
