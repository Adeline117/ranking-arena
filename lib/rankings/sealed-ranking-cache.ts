import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'
import {
  sealedRankingPublicationIdentity,
  type SealedRankingGenerationRead,
} from '@/lib/rankings/read-sealed-ranking-generation'

export const SEALED_RANKING_CACHE_CONTRACT = 'sealed-ranking-cache@1'

export interface SealedRankingCacheEntry<T> {
  readonly contract: typeof SEALED_RANKING_CACHE_CONTRACT
  readonly season: LeaderboardPublicationSeason
  readonly publicationIdentity: string
  readonly publication: SealedRankingGenerationRead<T>['publication']
  readonly cachedAt: string
  readonly value: T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Wrap a value that has completed the proof-A/read/proof-B authorization. */
export function createSealedRankingCacheEntry<T>(
  read: SealedRankingGenerationRead<T>,
  cachedAt = new Date(Date.now())
): SealedRankingCacheEntry<T> {
  if (!Number.isFinite(cachedAt.getTime())) {
    throw new TypeError('sealed ranking cache timestamp must be valid')
  }
  const cachedAtIso = cachedAt.toISOString()
  return Object.freeze({
    contract: SEALED_RANKING_CACHE_CONTRACT,
    season: read.publication.season,
    publicationIdentity: read.publicationIdentity,
    publication: read.publication,
    cachedAt: cachedAtIso,
    value: read.value,
  })
}

/**
 * Reject generic, legacy, malformed, or internally inconsistent cache values.
 *
 * This parser deliberately does not turn a cache entry back into live proof
 * authority. It authorizes only a last-good fallback value that was originally
 * written after the complete double-proof read.
 */
export function parseSealedRankingCacheEntry<T>(
  input: unknown,
  season: LeaderboardPublicationSeason
): SealedRankingCacheEntry<T> | null {
  try {
    if (!isRecord(input)) return null
    const keys = Object.keys(input).sort()
    const expectedKeys = [
      'cachedAt',
      'contract',
      'publication',
      'publicationIdentity',
      'season',
      'value',
    ].sort()
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      return null
    }
    if (input.contract !== SEALED_RANKING_CACHE_CONTRACT || input.season !== season) return null
    if (typeof input.publicationIdentity !== 'string' || !isRecord(input.publication)) return null
    if (
      input.publication.state !== 'sealed' ||
      input.publication.season !== season ||
      typeof input.publication.scoreCohortId !== 'string' ||
      !Array.isArray(input.publication.proofs)
    ) {
      return null
    }
    if (
      sealedRankingPublicationIdentity(input.publication as never) !== input.publicationIdentity
    ) {
      return null
    }
    if (typeof input.cachedAt !== 'string' || !Number.isFinite(Date.parse(input.cachedAt))) {
      return null
    }
    if (!Object.prototype.hasOwnProperty.call(input, 'value') || input.value === undefined) {
      return null
    }
    return {
      contract: SEALED_RANKING_CACHE_CONTRACT,
      season,
      publicationIdentity: input.publicationIdentity,
      publication: input.publication as unknown as SealedRankingCacheEntry<T>['publication'],
      cachedAt: input.cachedAt,
      value: input.value as T,
    }
  } catch {
    return null
  }
}
