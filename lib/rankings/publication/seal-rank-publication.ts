import { createHash } from 'node:crypto'

import type { PublicationRpcClient } from './rpc-client'
import type { PublicationWindow, SourcePublicationRow } from './source-publication-evidence'

export const LEADERBOARD_RANK_PUBLICATION_CONTRACT = 'leaderboard-rank-publication@1'
export const LEADERBOARD_RANK_PUBLICATION_RPC_TIMEOUT_MS = 30_000

const MAX_PUBLICATION_SOURCES = 256
const MAX_PUBLICATION_TRADER_IDENTITIES = 250_000
const MAX_PUBLICATION_REQUEST_BYTES = 64 * 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RFC3339_MICROSECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/

const SOURCE_PUBLICATION_KEYS = [
  'published_rank_count',
  'registry_slugs',
  'score_cohort_id',
  'snapshot_ids',
  'source',
  'source_as_of',
] as const

const SEAL_RESPONSE_KEYS = [
  'contract',
  'is_sealed',
  'proofs',
  'published_at',
  'score_cohort_id',
  'season_id',
  'source_count',
  'trader_count',
] as const

const SEAL_PROOF_KEYS = [
  'published_identity_sha256',
  'published_rank_count',
  'rank_mutation_seq',
  'recorded_at',
  'score_cohort_id',
  'source',
  'source_as_of',
] as const

export type SealRankPublicationErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'
  | 'rpc_ambiguous'

export class SealRankPublicationError extends Error {
  constructor(
    public readonly code: SealRankPublicationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'SealRankPublicationError'
  }
}

export interface SealRankPublicationInput {
  season: PublicationWindow
  scoreCohortId: string
  freshPublications: readonly SourcePublicationRow[]
  finalEligibleIdentityMap: ReadonlyMap<string, readonly string[]>
}

export interface SealRankPublicationOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LeaderboardRankPublicationProof {
  source: string
  source_as_of: string
  recorded_at: string
  score_cohort_id: string
  rank_mutation_seq: number
  published_rank_count: number
  published_identity_sha256: string
}

export interface LeaderboardRankPublicationSeal {
  contract: typeof LEADERBOARD_RANK_PUBLICATION_CONTRACT
  season_id: PublicationWindow
  score_cohort_id: string
  source_count: number
  trader_count: number
  published_at: string
  is_sealed: true
  proofs: LeaderboardRankPublicationProof[]
}

interface StrictSourcePublicationPayload {
  source: string
  source_as_of: string
  trader_ids: string[]
}

interface CanonicalPublicationExpectation extends StrictSourcePublicationPayload {
  publishedIdentitySha256: string
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
}

interface AbortableRpcQuery extends PromiseLike<RpcEnvelope> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcEnvelope>
}

type SealRpcClient = PublicationRpcClient

class AmbiguousRpcAttemptError extends Error {
  constructor(
    public readonly reason: 'timeout' | 'transport',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'AmbiguousRpcAttemptError'
  }
}

interface ParsedTimestamp {
  canonical: string
  epochMicros: bigint
}

function fail(code: SealRankPublicationErrorCode, message: string, options?: ErrorOptions): never {
  throw new SealRankPublicationError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const sortedExpected = [...expected].sort(compareText)
  return (
    actual.length === expected.length && actual.every((key, index) => key === sortedExpected[index])
  )
}

function isBuiltSourcePublicationRow(value: unknown): value is SourcePublicationRow {
  return (
    isRecord(value) &&
    hasExactKeys(value, SOURCE_PUBLICATION_KEYS) &&
    typeof value.source === 'string' &&
    typeof value.source_as_of === 'string' &&
    typeof value.published_rank_count === 'number' &&
    typeof value.score_cohort_id === 'string' &&
    Array.isArray(value.registry_slugs) &&
    value.registry_slugs.every((registrySlug) => typeof registrySlug === 'string') &&
    Array.isArray(value.snapshot_ids) &&
    value.snapshot_ids.every((snapshotId) => typeof snapshotId === 'number')
  )
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  return value % divisor < 0n ? quotient - 1n : quotient
}

function parseTimestamp(value: unknown, label: string): ParsedTimestamp {
  if (typeof value !== 'string') {
    fail('invalid_input', `${label} must be an RFC3339 timestamp`)
  }

  const match = RFC3339_MICROSECOND_PATTERN.exec(value)
  if (!match) {
    fail('invalid_input', `${label} must be an RFC3339 timestamp with timezone`)
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const probe = new Date(baseMs)

  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    fail('invalid_input', `${label} is not a real calendar timestamp`)
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const offsetHours = Number(match[10])
    const offsetMinutePart = Number(match[11])
    if (offsetHours > 23 || offsetMinutePart > 59) {
      fail('invalid_input', `${label} has an invalid timezone offset`)
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart)
  }

  const fractionMicros = BigInt((fraction ?? '').padEnd(6, '0') || '0')
  const epochMicros = BigInt(baseMs - offsetMinutes * 60_000) * 1000n + fractionMicros
  const epochSeconds = floorDivide(epochMicros, 1_000_000n)
  const microsWithinSecond = epochMicros - epochSeconds * 1_000_000n
  const utcDate = new Date(Number(epochSeconds * 1000n))
  if (!Number.isFinite(utcDate.getTime())) {
    fail('invalid_input', `${label} is outside the supported timestamp range`)
  }
  const canonical = `${utcDate.toISOString().slice(0, 19)}.${microsWithinSecond
    .toString()
    .padStart(6, '0')}Z`

  return { canonical, epochMicros }
}

function requireCanonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('invalid_input', `${label} must be a canonical lowercase UUID`)
  }
  return value
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('invalid_input', `${label} must be a non-negative safe integer`)
  }
  return value as number
}

function hasValidUnicodeScalars(value: string): boolean {
  if (value.includes('\u0000')) return false
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

function hashPostgresJsonbStringArray(values: readonly string[]): string {
  // PostgreSQL jsonb_out separates array members with `, `. JSON.stringify's
  // string escaping matches jsonb string output for the valid Unicode scalars
  // admitted above.
  const jsonbText = `[${values.map((value) => JSON.stringify(value)).join(', ')}]`
  return createHash('sha256').update(jsonbText, 'utf8').digest('hex')
}

function canonicalizeInput(input: SealRankPublicationInput): {
  args: {
    p_season_id: PublicationWindow
    p_score_cohort_id: string
    p_source_publications: StrictSourcePublicationPayload[]
  }
  expected: CanonicalPublicationExpectation[]
  traderCount: number
} {
  if (!['7D', '30D', '90D'].includes(input.season)) {
    fail('invalid_input', 'season must be 7D, 30D, or 90D')
  }
  const scoreCohortId = requireCanonicalUuid(input.scoreCohortId, 'scoreCohortId')
  if (
    !Array.isArray(input.freshPublications) ||
    input.freshPublications.length === 0 ||
    input.freshPublications.length > MAX_PUBLICATION_SOURCES
  ) {
    fail('invalid_input', 'freshPublications must contain 1..256 source publications')
  }
  if (!(input.finalEligibleIdentityMap instanceof Map)) {
    fail('invalid_input', 'finalEligibleIdentityMap must be a ReadonlyMap')
  }

  const publicationsBySource = new Map<string, SourcePublicationRow>()
  for (const rawPublication of input.freshPublications) {
    if (!isBuiltSourcePublicationRow(rawPublication)) {
      fail('invalid_input', 'freshPublications contains a non-buildSourcePublicationRows row')
    }
    const publication = rawPublication
    if (!SOURCE_PATTERN.test(publication.source)) {
      fail('invalid_input', 'freshPublications contains an invalid source')
    }
    if (publicationsBySource.has(publication.source)) {
      fail('invalid_input', `freshPublications contains duplicate source ${publication.source}`)
    }
    if (publication.score_cohort_id !== scoreCohortId) {
      fail('invalid_input', `${publication.source} publication cohort does not match caller cohort`)
    }
    requireNonNegativeSafeInteger(
      publication.published_rank_count,
      `${publication.source}.published_rank_count`
    )
    parseTimestamp(publication.source_as_of, `${publication.source}.source_as_of`)
    if (
      !Array.isArray(publication.registry_slugs) ||
      publication.registry_slugs.length === 0 ||
      publication.registry_slugs.some(
        (registrySlug) =>
          typeof registrySlug !== 'string' ||
          registrySlug.length === 0 ||
          registrySlug !== registrySlug.trim()
      ) ||
      !Array.isArray(publication.snapshot_ids) ||
      publication.snapshot_ids.length === 0 ||
      publication.snapshot_ids.some(
        (snapshotId) => !Number.isSafeInteger(snapshotId) || snapshotId <= 0
      )
    ) {
      fail('invalid_input', `${publication.source} publication evidence metadata is invalid`)
    }
    publicationsBySource.set(publication.source, publication)
  }

  for (const source of input.finalEligibleIdentityMap.keys()) {
    if (!publicationsBySource.has(source)) {
      fail('invalid_input', `finalEligibleIdentityMap contains non-fresh source ${source}`)
    }
  }

  let traderCount = 0
  const expected = [...publicationsBySource.values()]
    .sort((left, right) => compareText(left.source, right.source))
    .map((publication): CanonicalPublicationExpectation => {
      const rawIdentities = input.finalEligibleIdentityMap.get(publication.source)
      if (!Array.isArray(rawIdentities)) {
        fail('invalid_input', `${publication.source} final eligible identities were omitted`)
      }

      const identitySet = new Set<string>()
      for (const identity of rawIdentities) {
        if (
          typeof identity !== 'string' ||
          identity.length === 0 ||
          identity !== identity.trim() ||
          !hasValidUnicodeScalars(identity)
        ) {
          fail('invalid_input', `${publication.source} contains an invalid trader identity`)
        }
        identitySet.add(identity)
      }
      const traderIds = [...identitySet].sort(compareUtf8)
      if (traderIds.length !== publication.published_rank_count) {
        fail(
          'invalid_input',
          `${publication.source} eligible identity count does not match publication count`
        )
      }
      if (traderIds.length > MAX_PUBLICATION_TRADER_IDENTITIES) {
        fail('invalid_input', `${publication.source} exceeds the trader identity bound`)
      }
      traderCount += traderIds.length

      const sourceAsOf = parseTimestamp(
        publication.source_as_of,
        `${publication.source}.source_as_of`
      ).canonical
      return {
        source: publication.source,
        source_as_of: sourceAsOf,
        trader_ids: traderIds,
        publishedIdentitySha256: hashPostgresJsonbStringArray(traderIds),
      }
    })

  if (traderCount > MAX_PUBLICATION_TRADER_IDENTITIES) {
    fail('invalid_input', 'publication exceeds the trader identity bound')
  }

  const sourcePublications = expected.map(({ source, source_as_of, trader_ids }) => ({
    source,
    source_as_of,
    trader_ids,
  }))
  const args = {
    p_season_id: input.season,
    p_score_cohort_id: scoreCohortId,
    p_source_publications: sourcePublications,
  }
  if (
    Buffer.byteLength(JSON.stringify(sourcePublications), 'utf8') > MAX_PUBLICATION_REQUEST_BYTES
  ) {
    fail('invalid_input', 'source publication request exceeds 64 MiB')
  }

  return { args, expected, traderCount }
}

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : 'unknown RPC error'
  const code = typeof error.code === 'string' ? error.code : 'unknown'
  return `${message} (code=${code})`
}

function callSealRpc(
  supabase: SealRpcClient,
  args: {
    p_season_id: PublicationWindow
    p_score_cohort_id: string
    p_source_publications: StrictSourcePublicationPayload[]
  }
): AbortableRpcQuery {
  const rpc = Reflect.get(supabase, 'rpc')
  if (typeof rpc !== 'function') {
    fail('rpc_call_error', 'Supabase client has no RPC function')
  }

  let query: unknown
  try {
    query = Reflect.apply(rpc, supabase, ['seal_leaderboard_rank_publication', args])
  } catch (error) {
    fail('rpc_call_error', 'seal_leaderboard_rank_publication call failed before dispatch', {
      cause: error,
    })
  }

  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'seal_leaderboard_rank_publication returned no query')
  }
  const then = Reflect.get(query, 'then')
  const abortSignal = Reflect.get(query, 'abortSignal')
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    fail('rpc_call_error', 'seal_leaderboard_rank_publication returned a non-awaitable query')
  }
  return query as AbortableRpcQuery
}

async function runRpcAttempt(
  supabase: SealRpcClient,
  args: {
    p_season_id: PublicationWindow
    p_score_cohort_id: string
    p_source_publications: StrictSourcePublicationPayload[]
  },
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<RpcEnvelope> {
  if (externalSignal?.aborted) {
    fail('rpc_aborted', 'leaderboard publication seal was aborted before dispatch')
  }

  const query = callSealRpc(supabase, args)
  const controller = new AbortController()
  let timedOut = false
  let externallyAborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined

  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('leaderboard publication seal deadline exceeded'))
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        externallyAborted = true
        controller.abort(externalSignal.reason)
        reject(new Error('leaderboard publication seal aborted by caller'))
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
      removeExternalAbortListener = () => externalSignal.removeEventListener('abort', onAbort)
    }
  })

  try {
    let awaitable: PromiseLike<RpcEnvelope>
    try {
      awaitable =
        typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query
    } catch (error) {
      fail('rpc_call_error', 'seal RPC could not attach its AbortSignal before dispatch', {
        cause: error,
      })
    }
    if (!awaitable || typeof Reflect.get(awaitable, 'then') !== 'function') {
      fail('rpc_call_error', 'seal RPC AbortSignal binding returned a non-awaitable query')
    }
    return await Promise.race([Promise.resolve(awaitable), interruption])
  } catch (error) {
    if (error instanceof SealRankPublicationError) throw error
    if (externallyAborted) {
      fail('rpc_aborted', 'leaderboard publication seal was aborted by caller', { cause: error })
    }
    if (timedOut) {
      throw new AmbiguousRpcAttemptError(
        'timeout',
        `seal_leaderboard_rank_publication exceeded its ${timeoutMs}ms deadline`,
        { cause: error }
      )
    }
    throw new AmbiguousRpcAttemptError(
      'transport',
      'seal_leaderboard_rank_publication lost its response after dispatch',
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalAbortListener?.()
  }
}

function parseSealResponse(
  data: unknown,
  season: PublicationWindow,
  scoreCohortId: string,
  expected: readonly CanonicalPublicationExpectation[],
  traderCount: number
): LeaderboardRankPublicationSeal {
  if (!isRecord(data) || !hasExactKeys(data, SEAL_RESPONSE_KEYS)) {
    fail('rpc_shape_mismatch', 'seal RPC returned an invalid top-level response shape')
  }
  if (
    data.contract !== LEADERBOARD_RANK_PUBLICATION_CONTRACT ||
    data.season_id !== season ||
    data.score_cohort_id !== scoreCohortId ||
    data.source_count !== expected.length ||
    data.trader_count !== traderCount ||
    data.is_sealed !== true ||
    !Array.isArray(data.proofs) ||
    data.proofs.length !== expected.length
  ) {
    fail('rpc_shape_mismatch', 'seal RPC response does not match the requested publication')
  }

  let publishedAt: ParsedTimestamp
  try {
    publishedAt = parseTimestamp(data.published_at, 'published_at')
  } catch (error) {
    fail('rpc_shape_mismatch', 'seal RPC returned an invalid published_at timestamp', {
      cause: error,
    })
  }

  const proofs: LeaderboardRankPublicationProof[] = []
  for (let index = 0; index < expected.length; index += 1) {
    const rawProof: unknown = data.proofs[index]
    const expectedProof = expected[index]
    if (!isRecord(rawProof) || !hasExactKeys(rawProof, SEAL_PROOF_KEYS)) {
      fail('rpc_shape_mismatch', `seal RPC returned an invalid proof at index ${index}`)
    }

    let recordedAt: ParsedTimestamp
    try {
      recordedAt = parseTimestamp(rawProof.recorded_at, `${expectedProof.source}.recorded_at`)
    } catch (error) {
      fail('rpc_shape_mismatch', `${expectedProof.source} proof has an invalid recorded_at`, {
        cause: error,
      })
    }

    if (
      rawProof.source !== expectedProof.source ||
      rawProof.source_as_of !== expectedProof.source_as_of ||
      rawProof.score_cohort_id !== scoreCohortId ||
      rawProof.published_rank_count !== expectedProof.trader_ids.length ||
      rawProof.published_identity_sha256 !== expectedProof.publishedIdentitySha256 ||
      !SHA256_PATTERN.test(String(rawProof.published_identity_sha256)) ||
      !Number.isSafeInteger(rawProof.rank_mutation_seq) ||
      (rawProof.rank_mutation_seq as number) < 0 ||
      recordedAt.canonical !== rawProof.recorded_at ||
      recordedAt.epochMicros !== publishedAt.epochMicros
    ) {
      fail('rpc_shape_mismatch', `${expectedProof.source} proof does not match the request`)
    }

    proofs.push({
      source: rawProof.source,
      source_as_of: rawProof.source_as_of,
      recorded_at: rawProof.recorded_at,
      score_cohort_id: rawProof.score_cohort_id,
      rank_mutation_seq: rawProof.rank_mutation_seq,
      published_rank_count: rawProof.published_rank_count,
      published_identity_sha256: rawProof.published_identity_sha256,
    } as LeaderboardRankPublicationProof)
  }

  return {
    contract: LEADERBOARD_RANK_PUBLICATION_CONTRACT,
    season_id: season,
    score_cohort_id: scoreCohortId,
    source_count: expected.length,
    trader_count: traderCount,
    published_at: data.published_at as string,
    is_sealed: true,
    proofs,
  }
}

/**
 * Seal one already-written rank cohort. The caller owns the UUID and this
 * function reuses the exact same UUID and canonical payload for its sole
 * response-loss retry. A returned value means every requested source proof
 * was cryptographically bound to the final eligible identity set.
 */
export async function sealLeaderboardRankPublication(
  supabase: SealRpcClient,
  input: SealRankPublicationInput,
  options: SealRankPublicationOptions = {}
): Promise<LeaderboardRankPublicationSeal> {
  const timeoutMs = options.timeoutMs ?? LEADERBOARD_RANK_PUBLICATION_RPC_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('invalid_input', 'timeoutMs must be a positive safe integer')
  }

  const { args, expected, traderCount } = canonicalizeInput(input)
  let lastAmbiguousError: AmbiguousRpcAttemptError | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: RpcEnvelope
    try {
      response = await runRpcAttempt(supabase, args, timeoutMs, options.signal)
    } catch (error) {
      if (!(error instanceof AmbiguousRpcAttemptError)) throw error
      lastAmbiguousError = error
      if (attempt === 1 && !options.signal?.aborted) continue
      const code = error.reason === 'timeout' ? 'rpc_timeout' : 'rpc_ambiguous'
      fail(
        code,
        `seal RPC remained ambiguous after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        { cause: error }
      )
    }

    if (!response || typeof response !== 'object') {
      fail('rpc_error', 'seal RPC returned no envelope')
    }
    if (response.error !== null && response.error !== undefined) {
      fail('rpc_error', `seal RPC failed: ${describeRpcError(response.error)}`)
    }
    if (response.data === null || response.data === undefined) {
      fail('rpc_null', 'seal RPC returned null data')
    }
    return parseSealResponse(
      response.data,
      input.season,
      input.scoreCohortId,
      expected,
      traderCount
    )
  }

  fail('rpc_ambiguous', 'seal RPC did not produce a definitive response', {
    cause: lastAmbiguousError,
  })
}
