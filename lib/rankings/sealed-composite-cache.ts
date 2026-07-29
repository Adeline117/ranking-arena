import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import {
  type LeaderboardPublicationSeason,
  type SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import { sealedRankingPublicationIdentity } from '@/lib/rankings/read-sealed-ranking-generation'
import { parseSealedRankingPublication } from '@/lib/rankings/sealed-ranking-cache'

export const SEALED_COMPOSITE_CACHE_CONTRACT = 'sealed-composite-cache@1'
export const SEALED_COMPOSITE_SEASONS = Object.freeze([
  '7D',
  '30D',
  '90D',
] as const satisfies readonly LeaderboardPublicationSeason[])

export type SealedCompositePublications = Readonly<
  Record<LeaderboardPublicationSeason, SealedLeaderboardPublicationProofSet>
>

export interface SealedCompositeCacheEntry<T> {
  readonly contract: typeof SEALED_COMPOSITE_CACHE_CONTRACT
  readonly publicationIdentity: string
  readonly publications: SealedCompositePublications
  readonly cachedAt: string
  readonly value: T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sealedCompositePublicationIdentity(
  publications: SealedCompositePublications
): string {
  return JSON.stringify(
    SEALED_COMPOSITE_SEASONS.map((season) => [
      season,
      sealedRankingPublicationIdentity(publications[season]),
    ])
  )
}

function parsePublications(input: unknown): SealedCompositePublications | null {
  if (!isRecord(input)) return null
  const keys = Object.keys(input).sort()
  const expectedKeys = [...SEALED_COMPOSITE_SEASONS].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null
  }

  const publications = {} as Record<
    LeaderboardPublicationSeason,
    SealedLeaderboardPublicationProofSet
  >
  for (const season of SEALED_COMPOSITE_SEASONS) {
    const parsed = parseSealedRankingPublication(input[season], season)
    if (!parsed || parsed.proofs.some((proof) => !isPublicRankingSourceAllowed(proof.source))) {
      return null
    }
    publications[season] = parsed
  }
  return Object.freeze(publications)
}

export function createSealedCompositeCacheEntry<T>(
  value: T,
  publications: SealedCompositePublications,
  cachedAt = new Date(Date.now())
): SealedCompositeCacheEntry<T> {
  if (!Number.isFinite(cachedAt.getTime())) {
    throw new TypeError('sealed composite cache timestamp must be valid')
  }
  const parsedPublications = parsePublications(publications)
  if (!parsedPublications) {
    throw new TypeError('sealed composite cache publications are invalid')
  }

  return Object.freeze({
    contract: SEALED_COMPOSITE_CACHE_CONTRACT,
    publicationIdentity: sealedCompositePublicationIdentity(parsedPublications),
    publications: parsedPublications,
    cachedAt: cachedAt.toISOString(),
    value,
  })
}

export function parseSealedCompositeCacheEntry<T>(
  input: unknown
): SealedCompositeCacheEntry<T> | null {
  try {
    if (!isRecord(input)) return null
    const keys = Object.keys(input).sort()
    const expectedKeys = [
      'cachedAt',
      'contract',
      'publicationIdentity',
      'publications',
      'value',
    ].sort()
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return null
    }
    if (input.contract !== SEALED_COMPOSITE_CACHE_CONTRACT) return null
    const publications = parsePublications(input.publications)
    if (
      !publications ||
      typeof input.publicationIdentity !== 'string' ||
      sealedCompositePublicationIdentity(publications) !== input.publicationIdentity ||
      typeof input.cachedAt !== 'string' ||
      !Number.isFinite(Date.parse(input.cachedAt)) ||
      !Object.prototype.hasOwnProperty.call(input, 'value') ||
      input.value === undefined
    ) {
      return null
    }

    return {
      contract: SEALED_COMPOSITE_CACHE_CONTRACT,
      publicationIdentity: input.publicationIdentity,
      publications,
      cachedAt: input.cachedAt,
      value: input.value as T,
    }
  } catch {
    return null
  }
}
