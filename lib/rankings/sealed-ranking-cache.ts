import type {
  LeaderboardPublicationSeason,
  SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const PUBLICATION_KEYS = ['proofs', 'scoreCohortId', 'season', 'state'] as const
const PROOF_KEYS = [
  'season_id',
  'source',
  'source_as_of',
  'recorded_at',
  'score_cohort_id',
  'rank_mutation_seq',
  'current_mutation_seq',
  'published_rank_count',
  'published_identity_sha256',
  'is_sealed',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isSealedPublicationProofSet(
  value: unknown,
  season: LeaderboardPublicationSeason
): value is SealedLeaderboardPublicationProofSet {
  if (!isRecord(value) || !hasExactKeys(value, PUBLICATION_KEYS)) return false
  if (
    value.state !== 'sealed' ||
    value.season !== season ||
    typeof value.scoreCohortId !== 'string' ||
    !UUID_PATTERN.test(value.scoreCohortId) ||
    !Array.isArray(value.proofs) ||
    value.proofs.length === 0 ||
    value.proofs.length > 256
  ) {
    return false
  }

  let priorSource: string | undefined
  let recordedAt: string | undefined
  for (const proof of value.proofs) {
    if (!isRecord(proof) || !hasExactKeys(proof, PROOF_KEYS)) return false
    if (
      proof.season_id !== season ||
      typeof proof.source !== 'string' ||
      !SOURCE_PATTERN.test(proof.source) ||
      (priorSource !== undefined && proof.source <= priorSource) ||
      proof.score_cohort_id !== value.scoreCohortId ||
      proof.is_sealed !== true ||
      !isCanonicalTimestamp(proof.source_as_of) ||
      !isCanonicalTimestamp(proof.recorded_at) ||
      (recordedAt !== undefined && proof.recorded_at !== recordedAt) ||
      !isNonNegativeSafeInteger(proof.rank_mutation_seq) ||
      !isNonNegativeSafeInteger(proof.current_mutation_seq) ||
      proof.rank_mutation_seq !== proof.current_mutation_seq ||
      !isNonNegativeSafeInteger(proof.published_rank_count) ||
      typeof proof.published_identity_sha256 !== 'string' ||
      !SHA256_PATTERN.test(proof.published_identity_sha256)
    ) {
      return false
    }
    priorSource = proof.source
    recordedAt ??= proof.recorded_at
  }
  return true
}

export function parseSealedRankingPublication(
  value: unknown,
  season: LeaderboardPublicationSeason
): SealedLeaderboardPublicationProofSet | null {
  return isSealedPublicationProofSet(value, season) ? value : null
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
  season: LeaderboardPublicationSeason,
  expectedSources?: readonly string[]
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
    const publication = input.publication
    if (
      typeof input.publicationIdentity !== 'string' ||
      !isSealedPublicationProofSet(publication, season)
    ) {
      return null
    }
    if (sealedRankingPublicationIdentity(publication) !== input.publicationIdentity) {
      return null
    }
    if (expectedSources) {
      const canonicalExpectedSources = [...new Set(expectedSources)].sort()
      if (
        canonicalExpectedSources.length === 0 ||
        canonicalExpectedSources.length !== expectedSources.length ||
        canonicalExpectedSources.some((source) => !SOURCE_PATTERN.test(source)) ||
        canonicalExpectedSources.length !== publication.proofs.length ||
        canonicalExpectedSources.some(
          (source, index) => source !== publication.proofs[index].source
        )
      ) {
        return null
      }
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
      publication,
      cachedAt: input.cachedAt,
      value: input.value as T,
    }
  } catch {
    return null
  }
}
