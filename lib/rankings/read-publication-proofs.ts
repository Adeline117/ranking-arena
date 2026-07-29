import type { getSupabaseAdmin } from '@/lib/api'
import {
  RANKING_SOURCE_FUTURE_TOLERANCE_MS,
  RANKING_SOURCE_STALE_MS,
} from '@/lib/rankings/source-freshness'

export const LEADERBOARD_PUBLICATION_PROOFS_RPC_TIMEOUT_MS = 30_000
export const LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS = 60_000
export const LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES = 256
export const LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH = 128
export const LEADERBOARD_PUBLICATION_PROOFS_MAX_REQUEST_BYTES = 64 * 1024
export const LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS = 250_000

const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RFC3339_MICROSECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
const UTF8_ENCODER = new TextEncoder()
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)?.get
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener

const INPUT_KEYS = ['season', 'sources'] as const
const PROOF_KEYS = [
  'current_mutation_seq',
  'is_sealed',
  'published_identity_sha256',
  'published_rank_count',
  'rank_mutation_seq',
  'recorded_at',
  'score_cohort_id',
  'season_id',
  'source',
  'source_as_of',
] as const

export type LeaderboardPublicationSeason = '7D' | '30D' | '90D'

export type ReadPublicationProofsErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'
  | 'rpc_ambiguous'

export class ReadPublicationProofsError extends Error {
  constructor(
    public readonly code: ReadPublicationProofsErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ReadPublicationProofsError'
  }
}

export interface ReadPublicationProofsInput {
  season: LeaderboardPublicationSeason
  sources: readonly string[]
}

export interface ReadPublicationProofsOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Fixed authorization clock. Defaults to the instant this read begins. */
  now?: Date
}

export interface SealedLeaderboardPublicationProof {
  readonly season_id: LeaderboardPublicationSeason
  readonly source: string
  readonly source_as_of: string
  readonly recorded_at: string
  readonly score_cohort_id: string
  readonly rank_mutation_seq: number
  readonly current_mutation_seq: number
  readonly published_rank_count: number
  readonly published_identity_sha256: string
  readonly is_sealed: true
}

export interface SealedLeaderboardPublicationProofSet {
  readonly state: 'sealed'
  readonly season: LeaderboardPublicationSeason
  readonly scoreCohortId: string
  readonly proofs: readonly SealedLeaderboardPublicationProof[]
}

interface PublicationProofRpcArgs {
  readonly p_season_id: LeaderboardPublicationSeason
  readonly p_sources: readonly string[]
}

export interface CanonicalPublicationProofInput {
  readonly season: LeaderboardPublicationSeason
  readonly sources: readonly string[]
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
  status?: unknown
}

interface PreparedRpcQuery {
  readonly query: object | ((...args: never[]) => unknown)
  readonly bindAbortSignal?: (signal: AbortSignal) => unknown
  readonly directThen?: (
    onfulfilled: (value: RpcEnvelope) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
}

interface ParsedTimestamp {
  canonical: string
  epochMicros: bigint
}

type PublicationProofRpcClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

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

function fail(
  code: ReadPublicationProofsErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new ReadPublicationProofsError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const canonicalExpected = [...expected].sort(compareText)
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    if (value === null || typeof value !== 'object') return false
    readAbortSignalAborted(value)
    return true
  } catch {
    return false
  }
}

function readAbortSignalAborted(value: object): boolean {
  if (typeof ABORT_SIGNAL_ABORTED_GETTER !== 'function') {
    throw new TypeError('AbortSignal aborted getter is unavailable')
  }
  const aborted = Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, value, [])
  if (typeof aborted !== 'boolean') {
    throw new TypeError('AbortSignal aborted getter returned a non-boolean value')
  }
  return aborted
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  return value % divisor < 0n ? quotient - 1n : quotient
}

function parseTimestamp(value: unknown, label: string): ParsedTimestamp {
  if (typeof value !== 'string') {
    fail('rpc_shape_mismatch', `${label} must be an RFC3339 timestamp`)
  }

  const match = RFC3339_MICROSECOND_PATTERN.exec(value)
  if (!match) {
    fail('rpc_shape_mismatch', `${label} must be an RFC3339 timestamp with timezone`)
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
    fail('rpc_shape_mismatch', `${label} is not a real calendar timestamp`)
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const offsetHours = Number(match[10])
    const offsetMinutePart = Number(match[11])
    if (offsetHours > 23 || offsetMinutePart > 59) {
      fail('rpc_shape_mismatch', `${label} has an invalid timezone offset`)
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart)
  }

  const fractionMicros = BigInt((fraction ?? '').padEnd(6, '0') || '0')
  const epochMicros = BigInt(baseMs - offsetMinutes * 60_000) * 1000n + fractionMicros
  const epochSeconds = floorDivide(epochMicros, 1_000_000n)
  const microsWithinSecond = epochMicros - epochSeconds * 1_000_000n
  const utcDate = new Date(Number(epochSeconds * 1000n))
  if (!Number.isFinite(utcDate.getTime())) {
    fail('rpc_shape_mismatch', `${label} is outside the supported timestamp range`)
  }

  return {
    canonical: `${utcDate.toISOString().slice(0, 19)}.${microsWithinSecond
      .toString()
      .padStart(6, '0')}Z`,
    epochMicros,
  }
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('rpc_shape_mismatch', `${label} must be a non-negative safe integer`)
  }
  return value as number
}

export function canonicalizePublicationProofInput(
  input: ReadPublicationProofsInput
): CanonicalPublicationProofInput {
  try {
    if (!isRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
      fail('invalid_input', 'publication proof input must contain exactly season and sources')
    }
    const season = Reflect.get(input, 'season')
    const rawSources = Reflect.get(input, 'sources')

    if (season !== '7D' && season !== '30D' && season !== '90D') {
      fail('invalid_input', 'season must be exactly 7D, 30D, or 90D')
    }
    if (!Array.isArray(rawSources)) {
      fail('invalid_input', 'sources must contain 1..256 canonical authority sources')
    }
    const sourceCount = Reflect.get(rawSources, 'length')
    if (
      !Number.isSafeInteger(sourceCount) ||
      (sourceCount as number) === 0 ||
      (sourceCount as number) > LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCES
    ) {
      fail('invalid_input', 'sources must contain 1..256 canonical authority sources')
    }

    const seen = new Set<string>()
    for (let index = 0; index < (sourceCount as number); index += 1) {
      const source = Reflect.get(rawSources, String(index))
      if (
        typeof source !== 'string' ||
        source.length > LEADERBOARD_PUBLICATION_PROOFS_MAX_SOURCE_LENGTH ||
        !SOURCE_PATTERN.test(source)
      ) {
        fail('invalid_input', 'sources contains a non-canonical authority source')
      }
      if (seen.has(source)) {
        fail('invalid_input', `sources contains duplicate authority source ${source}`)
      }
      seen.add(source)
    }

    const sources = Object.freeze([...seen].sort(compareText))
    const canonical = Object.freeze({
      season,
      sources,
    })
    if (
      UTF8_ENCODER.encode(
        JSON.stringify({
          p_season_id: canonical.season,
          p_sources: canonical.sources,
        })
      ).byteLength > LEADERBOARD_PUBLICATION_PROOFS_MAX_REQUEST_BYTES
    ) {
      fail('invalid_input', 'publication proof request exceeds 64 KiB')
    }
    return canonical
  } catch (error) {
    if (error instanceof ReadPublicationProofsError) throw error
    fail('invalid_input', 'publication proof input could not be inspected safely', { cause: error })
  }
}

function publicationProofRpcArgs(input: CanonicalPublicationProofInput): PublicationProofRpcArgs {
  return Object.freeze({
    p_season_id: input.season,
    p_sources: input.sources,
  })
}

function requireOptions(
  options: ReadPublicationProofsOptions,
  defaultNow: Date
): {
  timeoutMs: number
  signal: AbortSignal | undefined
  nowEpochMicros: bigint
} {
  try {
    if (!isRecord(options)) {
      fail('invalid_input', 'publication proof options must be an object')
    }
    const rawTimeoutMs = Reflect.get(options, 'timeoutMs')
    const rawSignal = Reflect.get(options, 'signal')
    const requestedNow = Reflect.get(options, 'now')
    const timeoutMs =
      rawTimeoutMs === undefined ? LEADERBOARD_PUBLICATION_PROOFS_RPC_TIMEOUT_MS : rawTimeoutMs
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS
    ) {
      fail(
        'invalid_input',
        `timeoutMs must be a positive safe integer no greater than ${LEADERBOARD_PUBLICATION_PROOFS_MAX_TIMEOUT_MS}`
      )
    }
    if (rawSignal !== undefined && !isAbortSignal(rawSignal)) {
      fail('invalid_input', 'signal must be an AbortSignal')
    }
    const now = requestedNow === undefined ? defaultNow : requestedNow
    if (!(now instanceof Date)) {
      fail('invalid_input', 'now must be a valid Date')
    }
    let nowMs: number
    try {
      nowMs = Date.prototype.getTime.call(now)
    } catch (error) {
      fail('invalid_input', 'now must be a valid Date', { cause: error })
    }
    if (!Number.isFinite(nowMs)) {
      fail('invalid_input', 'now must be a valid Date')
    }
    return { timeoutMs, signal: rawSignal, nowEpochMicros: BigInt(nowMs) * 1000n }
  } catch (error) {
    if (error instanceof ReadPublicationProofsError) throw error
    fail('invalid_input', 'publication proof options could not be inspected safely', {
      cause: error,
    })
  }
}

function callPublicationProofRpc(
  supabase: PublicationProofRpcClient,
  args: PublicationProofRpcArgs
): PreparedRpcQuery {
  let rpc: unknown
  try {
    rpc = Reflect.get(supabase, 'rpc')
  } catch (error) {
    fail('rpc_call_error', 'could not read the Supabase RPC function', { cause: error })
  }
  if (typeof rpc !== 'function') {
    fail('rpc_call_error', 'Supabase client has no RPC function')
  }

  let query: unknown
  try {
    // The proof migration is deliberately deployed before this dormant reader
    // is wired into public traffic. Reflection keeps generated production
    // types attested to the deployed schema instead of hand-editing them.
    query = Reflect.apply(rpc, supabase, ['arena_leaderboard_publication_proofs', args])
  } catch (error) {
    fail('rpc_call_error', 'publication proof RPC call failed before dispatch', { cause: error })
  }

  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'publication proof RPC returned no query')
  }

  let then: unknown
  let abortSignal: unknown
  try {
    then = Reflect.get(query, 'then')
    abortSignal = Reflect.get(query, 'abortSignal')
  } catch (error) {
    fail('rpc_call_error', 'publication proof RPC returned an unreadable query', { cause: error })
  }
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    fail('rpc_call_error', 'publication proof RPC returned a non-awaitable query')
  }

  return {
    query,
    bindAbortSignal:
      typeof abortSignal === 'function'
        ? (signal) => Reflect.apply(abortSignal, query, [signal])
        : undefined,
    directThen:
      typeof then === 'function'
        ? (onfulfilled, onrejected) => Reflect.apply(then, query, [onfulfilled, onrejected])
        : undefined,
  }
}

function prepareAwaitable(
  prepared: PreparedRpcQuery,
  signal: AbortSignal
): {
  readonly then: (
    onfulfilled: (value: RpcEnvelope) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
} {
  if (!prepared.bindAbortSignal) {
    if (!prepared.directThen) {
      fail('rpc_call_error', 'publication proof RPC query has no awaitable terminator')
    }
    return { then: prepared.directThen }
  }

  let awaitable: unknown
  try {
    awaitable = prepared.bindAbortSignal(signal)
  } catch (error) {
    fail('rpc_call_error', 'publication proof RPC could not attach its AbortSignal', {
      cause: error,
    })
  }
  if ((typeof awaitable !== 'object' && typeof awaitable !== 'function') || awaitable === null) {
    fail('rpc_call_error', 'publication proof RPC AbortSignal binding returned no query')
  }

  let then: unknown
  try {
    then = Reflect.get(awaitable, 'then')
  } catch (error) {
    fail('rpc_call_error', 'publication proof RPC AbortSignal binding was unreadable', {
      cause: error,
    })
  }
  if (typeof then !== 'function') {
    fail('rpc_call_error', 'publication proof RPC AbortSignal binding was not awaitable')
  }
  return {
    then: (onfulfilled, onrejected) => Reflect.apply(then, awaitable, [onfulfilled, onrejected]),
  }
}

function dispatchAwaitable(awaitable: ReturnType<typeof prepareAwaitable>): Promise<RpcEnvelope> {
  let synchronousThrow = false
  let thrownValue: unknown
  const promise = new Promise<RpcEnvelope>((resolve, reject) => {
    try {
      awaitable.then(resolve, reject)
    } catch (error) {
      synchronousThrow = true
      thrownValue = error
    }
  })
  if (synchronousThrow) {
    fail('rpc_call_error', 'publication proof RPC thenable threw before dispatch', {
      cause: thrownValue,
    })
  }
  return promise
}

async function runRpcAttempt(
  supabase: PublicationProofRpcClient,
  args: PublicationProofRpcArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<RpcEnvelope> {
  if (externalSignal && readAbortSignalAborted(externalSignal)) {
    fail('rpc_aborted', 'publication proof read was aborted before dispatch')
  }

  const controller = new AbortController()
  const prepared = callPublicationProofRpc(supabase, args)
  const awaitable = prepareAwaitable(prepared, controller.signal)
  let timedOut = false
  let externallyAborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined

  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('publication proof read deadline exceeded'))
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        externallyAborted = true
        controller.abort()
        reject(new Error('publication proof read aborted by caller'))
      }
      Reflect.apply(EVENT_TARGET_ADD_EVENT_LISTENER, externalSignal, [
        'abort',
        onAbort,
        { once: true },
      ])
      removeExternalAbortListener = () => {
        Reflect.apply(EVENT_TARGET_REMOVE_EVENT_LISTENER, externalSignal, ['abort', onAbort])
      }
      if (readAbortSignalAborted(externalSignal)) onAbort()
    }
  })

  try {
    return await Promise.race([dispatchAwaitable(awaitable), interruption])
  } catch (error) {
    if (error instanceof ReadPublicationProofsError) throw error
    if (externallyAborted) {
      fail('rpc_aborted', 'publication proof read was aborted by caller', { cause: error })
    }
    if (timedOut) {
      throw new AmbiguousRpcAttemptError(
        'timeout',
        `arena_leaderboard_publication_proofs exceeded its ${timeoutMs}ms deadline`,
        { cause: error }
      )
    }
    throw new AmbiguousRpcAttemptError(
      'transport',
      'arena_leaderboard_publication_proofs lost its response after dispatch',
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalAbortListener?.()
  }
}

function parseProofResponse(
  data: unknown,
  args: PublicationProofRpcArgs,
  nowEpochMicros: bigint
): SealedLeaderboardPublicationProofSet {
  try {
    if (!Array.isArray(data) || data.length !== args.p_sources.length) {
      fail('rpc_shape_mismatch', 'publication proof RPC returned the wrong number of rows')
    }

    const proofs: SealedLeaderboardPublicationProof[] = []
    let scoreCohortId: string | undefined
    let recordedAt: string | undefined
    let totalPublishedRankCount = 0
    const staleCutoffMicros = nowEpochMicros - BigInt(RANKING_SOURCE_STALE_MS) * 1000n
    const futureCutoffMicros = nowEpochMicros + BigInt(RANKING_SOURCE_FUTURE_TOLERANCE_MS) * 1000n

    for (let index = 0; index < args.p_sources.length; index += 1) {
      const raw: unknown = data[index]
      const expectedSource = args.p_sources[index]
      if (!isRecord(raw) || !hasExactKeys(raw, PROOF_KEYS)) {
        fail('rpc_shape_mismatch', `publication proof row ${index} has an invalid shape`)
      }
      const rawCurrentMutationSeq = Reflect.get(raw, 'current_mutation_seq')
      const rawIsSealed = Reflect.get(raw, 'is_sealed')
      const rawPublishedIdentitySha256 = Reflect.get(raw, 'published_identity_sha256')
      const rawPublishedRankCount = Reflect.get(raw, 'published_rank_count')
      const rawRankMutationSeq = Reflect.get(raw, 'rank_mutation_seq')
      const rawRecordedAt = Reflect.get(raw, 'recorded_at')
      const rawScoreCohortId = Reflect.get(raw, 'score_cohort_id')
      const rawSeasonId = Reflect.get(raw, 'season_id')
      const rawSource = Reflect.get(raw, 'source')
      const rawSourceAsOf = Reflect.get(raw, 'source_as_of')

      if (rawSeasonId !== args.p_season_id || rawSource !== expectedSource) {
        fail('rpc_shape_mismatch', `publication proof row ${index} does not match its request`)
      }
      if (rawIsSealed !== true) {
        fail('rpc_shape_mismatch', `${expectedSource} publication proof is not sealed`)
      }
      if (typeof rawScoreCohortId !== 'string' || !UUID_PATTERN.test(rawScoreCohortId)) {
        fail('rpc_shape_mismatch', `${expectedSource} has an invalid score cohort`)
      }
      if (scoreCohortId !== undefined && rawScoreCohortId !== scoreCohortId) {
        fail('rpc_shape_mismatch', 'publication proof rows contain mixed score cohorts')
      }
      scoreCohortId ??= rawScoreCohortId

      const rankMutationSeq = requireNonNegativeSafeInteger(
        rawRankMutationSeq,
        `${expectedSource}.rank_mutation_seq`
      )
      const currentMutationSeq = requireNonNegativeSafeInteger(
        rawCurrentMutationSeq,
        `${expectedSource}.current_mutation_seq`
      )
      if (rankMutationSeq !== currentMutationSeq) {
        fail('rpc_shape_mismatch', `${expectedSource} publication fence has advanced`)
      }
      const publishedRankCount = requireNonNegativeSafeInteger(
        rawPublishedRankCount,
        `${expectedSource}.published_rank_count`
      )
      if (publishedRankCount > LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS) {
        fail('rpc_shape_mismatch', `${expectedSource} published rank count exceeds the limit`)
      }
      totalPublishedRankCount += publishedRankCount
      if (totalPublishedRankCount > LEADERBOARD_PUBLICATION_PROOFS_MAX_TRADERS) {
        fail('rpc_shape_mismatch', 'publication proof total rank count exceeds the limit')
      }
      if (
        typeof rawPublishedIdentitySha256 !== 'string' ||
        !SHA256_PATTERN.test(rawPublishedIdentitySha256)
      ) {
        fail('rpc_shape_mismatch', `${expectedSource} has an invalid identity digest`)
      }

      const sourceAsOf = parseTimestamp(rawSourceAsOf, `${expectedSource}.source_as_of`)
      const rowRecordedAt = parseTimestamp(rawRecordedAt, `${expectedSource}.recorded_at`)
      if (
        sourceAsOf.epochMicros <= staleCutoffMicros ||
        sourceAsOf.epochMicros > futureCutoffMicros
      ) {
        fail('rpc_shape_mismatch', `${expectedSource} source proof is not currently fresh`)
      }
      if (rowRecordedAt.epochMicros > futureCutoffMicros) {
        fail('rpc_shape_mismatch', `${expectedSource} publication timestamp is in the future`)
      }
      if (
        sourceAsOf.epochMicros >
        rowRecordedAt.epochMicros + BigInt(RANKING_SOURCE_FUTURE_TOLERANCE_MS) * 1000n
      ) {
        fail('rpc_shape_mismatch', `${expectedSource} source timestamp exceeds seal tolerance`)
      }
      if (recordedAt !== undefined && rowRecordedAt.canonical !== recordedAt) {
        fail('rpc_shape_mismatch', 'one score cohort contains multiple publication timestamps')
      }
      recordedAt ??= rowRecordedAt.canonical

      proofs.push(
        Object.freeze({
          season_id: args.p_season_id,
          source: expectedSource,
          source_as_of: sourceAsOf.canonical,
          recorded_at: rowRecordedAt.canonical,
          score_cohort_id: rawScoreCohortId,
          rank_mutation_seq: rankMutationSeq,
          current_mutation_seq: currentMutationSeq,
          published_rank_count: publishedRankCount,
          published_identity_sha256: rawPublishedIdentitySha256,
          is_sealed: true,
        })
      )
    }

    if (scoreCohortId === undefined) {
      fail('rpc_shape_mismatch', 'publication proof RPC returned no score cohort')
    }

    return Object.freeze({
      state: 'sealed',
      season: args.p_season_id,
      scoreCohortId,
      proofs: Object.freeze(proofs),
    })
  } catch (error) {
    if (error instanceof ReadPublicationProofsError) throw error
    fail('rpc_shape_mismatch', 'publication proof response could not be inspected safely', {
      cause: error,
    })
  }
}

function inspectRpcEnvelope(response: unknown): RpcEnvelope {
  try {
    if (!isRecord(response)) {
      fail('rpc_error', 'publication proof RPC returned no envelope')
    }
    return {
      data: Reflect.get(response, 'data'),
      error: Reflect.get(response, 'error'),
      status: Reflect.get(response, 'status'),
    }
  } catch (error) {
    if (error instanceof ReadPublicationProofsError) throw error
    fail('rpc_error', 'publication proof RPC envelope could not be inspected safely', {
      cause: error,
    })
  }
}

type RpcEnvelopeDisposition =
  | { readonly state: 'ambiguous' }
  | { readonly state: 'error'; readonly description: string }
  | { readonly state: 'success' }

function inspectRpcEnvelopeDisposition(envelope: RpcEnvelope): RpcEnvelopeDisposition {
  if (envelope.status === 0) return { state: 'ambiguous' }

  if (
    !Number.isSafeInteger(envelope.status) ||
    (envelope.status as number) < 100 ||
    (envelope.status as number) > 599
  ) {
    return { state: 'error', description: 'invalid HTTP status' }
  }
  const status = envelope.status as number
  const isGatewayFailure = status === 502 || status === 503 || status === 504
  const isHttpFailure = status < 200 || status > 299

  if (envelope.error === null || envelope.error === undefined) {
    if (isGatewayFailure) return { state: 'ambiguous' }
    return isHttpFailure
      ? { state: 'error', description: `HTTP status ${String(status)}` }
      : { state: 'success' }
  }

  try {
    if (!isRecord(envelope.error)) {
      return isGatewayFailure
        ? { state: 'ambiguous' }
        : { state: 'error', description: String(envelope.error) }
    }

    // Snapshot nested caller-controlled fields once. Classification and the
    // eventual diagnostic must be derived from the same immutable view.
    const code = Reflect.get(envelope.error, 'code')
    const message = Reflect.get(envelope.error, 'message')
    if (isGatewayFailure && (typeof code !== 'string' || code.trim().length === 0)) {
      return { state: 'ambiguous' }
    }
    return {
      state: 'error',
      description: `${typeof message === 'string' ? message : 'unknown RPC error'} (code=${
        typeof code === 'string' ? code : 'unknown'
      })`,
    }
  } catch (error) {
    fail('rpc_error', 'publication proof RPC returned an unreadable error envelope', {
      cause: error,
    })
  }
}

/**
 * Read the complete immutable publication proof set for one authority season.
 * This client is intentionally dormant until the proof migration is deployed.
 * A returned value is always a fully sealed, single-cohort result; missing,
 * empty, malformed, unsealed, and unavailable states are typed failures.
 */
export async function readLeaderboardPublicationProofs(
  supabase: PublicationProofRpcClient,
  input: ReadPublicationProofsInput,
  options: ReadPublicationProofsOptions = {}
): Promise<SealedLeaderboardPublicationProofSet> {
  const callStartedAt = new Date(Date.now())
  const args = publicationProofRpcArgs(canonicalizePublicationProofInput(input))
  const { timeoutMs, signal, nowEpochMicros } = requireOptions(options, callStartedAt)
  let lastAmbiguousError: AmbiguousRpcAttemptError | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: RpcEnvelope
    try {
      response = await runRpcAttempt(supabase, args, timeoutMs, signal)
    } catch (error) {
      if (!(error instanceof AmbiguousRpcAttemptError)) throw error
      lastAmbiguousError = error
      if (signal && readAbortSignalAborted(signal)) {
        fail('rpc_aborted', 'publication proof read was aborted by caller', { cause: error })
      }
      if (attempt === 1) continue

      fail(
        error.reason === 'timeout' ? 'rpc_timeout' : 'rpc_ambiguous',
        `publication proof RPC remained ambiguous after ${attempt} attempts`,
        { cause: error }
      )
    }

    const envelope = inspectRpcEnvelope(response)
    const disposition = inspectRpcEnvelopeDisposition(envelope)
    if (disposition.state === 'ambiguous') {
      const transportError = new AmbiguousRpcAttemptError(
        'transport',
        `arena_leaderboard_publication_proofs returned ambiguous transport status ${String(
          envelope.status
        )}`,
        { cause: envelope.error }
      )
      lastAmbiguousError = transportError
      if (signal && readAbortSignalAborted(signal)) {
        fail('rpc_aborted', 'publication proof read was aborted by caller', {
          cause: transportError,
        })
      }
      if (attempt === 1) continue
      fail('rpc_ambiguous', `publication proof RPC remained ambiguous after ${attempt} attempts`, {
        cause: transportError,
      })
    }
    if (disposition.state === 'error') {
      fail('rpc_error', `publication proof RPC failed: ${disposition.description}`)
    }
    if (envelope.data === null || envelope.data === undefined) {
      fail('rpc_null', 'publication proof RPC returned null data')
    }
    return parseProofResponse(envelope.data, args, nowEpochMicros)
  }

  fail('rpc_ambiguous', 'publication proof RPC did not produce a definitive response', {
    cause: lastAmbiguousError,
  })
}
