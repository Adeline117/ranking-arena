import type { getSupabaseAdmin } from '@/lib/api'
import type { PublicationWindow } from './source-publication-evidence'

export const LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT = 'leaderboard-rank-generation-claim@1'
export const LEADERBOARD_RANK_GENERATION_CLAIM_RPC_TIMEOUT_MS = 30_000
export const LEADERBOARD_RANK_GENERATION_CLAIM_MAX_TIMEOUT_MS = 60_000
export const LEADERBOARD_RANK_GENERATION_CLAIM_LEASE_TIMEOUT_DIVISOR = 3
// The authoritative PG17 scorer/manifest accepts one globally comparable
// non-empty cohort of at most 64,000 inputs. The writer freezes exactly 1,000
// rows per immutable batch except for the final tail. Raising either bound
// requires a scorer/writer upgrade, not an alternative caller-side split.
export const LEADERBOARD_RANK_GENERATION_MAX_ROWS = 64_000
export const LEADERBOARD_RANK_GENERATION_MAX_ROWS_PER_BATCH = 1_000
export const LEADERBOARD_RANK_GENERATION_MAX_BATCHES = 64
export const LEADERBOARD_RANK_GENERATION_MAX_SEQUENCE = 9_007_199_254_740_000

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const RFC3339_MICROSECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
const INPUT_KEYS = [
  'computedAt',
  'expectedBatchCount',
  'expectedRankCount',
  'leaseSeconds',
  'scoreCohortId',
  'season',
  'writeSetSha256',
] as const
const OPTION_KEYS = ['signal', 'timeoutMs'] as const
const RESPONSE_KEYS = [
  'claimed_at',
  'computed_at',
  'contract',
  'expected_batch_count',
  'expected_rank_count',
  'generation_seq',
  'lease_expires_at',
  'phase',
  'score_cohort_id',
  'season_id',
  'write_set_sha256',
] as const
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)?.get
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener

export type ClaimRankGenerationErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'
  | 'rpc_ambiguous'

export class ClaimRankGenerationError extends Error {
  constructor(
    public readonly code: ClaimRankGenerationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ClaimRankGenerationError'
  }
}

export interface ClaimRankGenerationInput {
  season: PublicationWindow
  scoreCohortId: string
  writeSetSha256: string
  expectedRankCount: number
  expectedBatchCount: number
  computedAt: string
  leaseSeconds: number
}

export interface ClaimRankGenerationOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LeaderboardRankGenerationClaim {
  readonly contract: typeof LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT
  readonly season_id: PublicationWindow
  readonly score_cohort_id: string
  readonly generation_seq: number
  readonly phase: 'claimed'
  readonly write_set_sha256: string
  readonly expected_rank_count: number
  readonly expected_batch_count: number
  readonly computed_at: string
  readonly claimed_at: string
  readonly lease_expires_at: string
}

interface ClaimRpcArgs {
  readonly p_season_id: PublicationWindow
  readonly p_score_cohort_id: string
  readonly p_write_set_sha256: string
  readonly p_expected_rank_count: number
  readonly p_expected_batch_count: number
  readonly p_computed_at: string
  readonly p_lease_seconds: number
}

interface RpcEnvelope {
  readonly data: unknown
  readonly error: unknown
  readonly status: unknown
}

interface PreparedRpcQuery {
  readonly query: object | ((...args: never[]) => unknown)
  readonly bindAbortSignal?: (signal: AbortSignal) => unknown
  readonly directThen?: (
    onfulfilled: (value: unknown) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
}

interface PreparedAwaitable {
  readonly then: (
    onfulfilled: (value: unknown) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
}

interface ParsedTimestamp {
  readonly canonical: string
  readonly epochMicros: bigint
}

type ClaimRpcClient = Pick<ReturnType<typeof getSupabaseAdmin>, 'rpc'>

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

function fail(code: ClaimRankGenerationErrorCode, message: string, options?: ErrorOptions): never {
  throw new ClaimRankGenerationError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const sortedExpected = [...expected].sort(compareText)
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  return value % divisor < 0n ? quotient - 1n : quotient
}

function parseTimestamp(value: unknown, label: string, errorCode: ClaimRankGenerationErrorCode) {
  if (typeof value !== 'string') {
    fail(errorCode, `${label} must be an RFC3339 timestamp`)
  }
  const match = RFC3339_MICROSECOND_PATTERN.exec(value)
  if (!match) {
    fail(errorCode, `${label} must be an RFC3339 timestamp with timezone`)
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
    fail(errorCode, `${label} is not a real calendar timestamp`)
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const offsetHours = Number(match[10])
    const offsetMinutePart = Number(match[11])
    if (offsetHours > 23 || offsetMinutePart > 59) {
      fail(errorCode, `${label} has an invalid timezone offset`)
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart)
  }

  const fractionMicros = BigInt((fraction ?? '').padEnd(6, '0') || '0')
  const epochMicros = BigInt(baseMs - offsetMinutes * 60_000) * 1000n + fractionMicros
  const epochSeconds = floorDivide(epochMicros, 1_000_000n)
  const microsWithinSecond = epochMicros - epochSeconds * 1_000_000n
  const utcDate = new Date(Number(epochSeconds * 1000n))
  if (
    !Number.isFinite(utcDate.getTime()) ||
    utcDate.getUTCFullYear() < 1000 ||
    utcDate.getUTCFullYear() > 9999
  ) {
    fail(errorCode, `${label} is outside the supported timestamp range`)
  }
  return {
    canonical: `${utcDate.toISOString().slice(0, 19)}.${microsWithinSecond
      .toString()
      .padStart(6, '0')}Z`,
    epochMicros,
  } satisfies ParsedTimestamp
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

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    if (value === null || typeof value !== 'object') return false
    readAbortSignalAborted(value)
    return true
  } catch {
    return false
  }
}

function canonicalizeInputUnsafe(input: unknown): ClaimRpcArgs {
  if (!isRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
    fail('invalid_input', 'generation claim input must have the exact contract keys')
  }

  const season = Reflect.get(input, 'season')
  const scoreCohortId = Reflect.get(input, 'scoreCohortId')
  const writeSetSha256 = Reflect.get(input, 'writeSetSha256')
  const expectedRankCount = Reflect.get(input, 'expectedRankCount')
  const expectedBatchCount = Reflect.get(input, 'expectedBatchCount')
  const computedAt = Reflect.get(input, 'computedAt')
  const leaseSeconds = Reflect.get(input, 'leaseSeconds')

  if (typeof season !== 'string' || !['7D', '30D', '90D'].includes(season)) {
    fail('invalid_input', 'season must be exactly 7D, 30D, or 90D')
  }
  if (typeof scoreCohortId !== 'string' || !UUID_PATTERN.test(scoreCohortId)) {
    fail('invalid_input', 'scoreCohortId must be a canonical lowercase UUID')
  }
  if (typeof writeSetSha256 !== 'string' || !SHA256_PATTERN.test(writeSetSha256)) {
    fail('invalid_input', 'writeSetSha256 must be a lowercase sha256')
  }
  if (
    !Number.isSafeInteger(expectedRankCount) ||
    (expectedRankCount as number) < 1 ||
    (expectedRankCount as number) > LEADERBOARD_RANK_GENERATION_MAX_ROWS ||
    !Number.isSafeInteger(expectedBatchCount) ||
    (expectedBatchCount as number) < 1 ||
    (expectedBatchCount as number) > LEADERBOARD_RANK_GENERATION_MAX_BATCHES ||
    (expectedBatchCount as number) !==
      Math.ceil((expectedRankCount as number) / LEADERBOARD_RANK_GENERATION_MAX_ROWS_PER_BATCH)
  ) {
    fail(
      'invalid_input',
      'expectedRankCount must be between 1 and 64000 and expectedBatchCount must equal ceil(expectedRankCount / 1000)'
    )
  }
  if (
    !Number.isSafeInteger(leaseSeconds) ||
    (leaseSeconds as number) < 15 ||
    (leaseSeconds as number) > 300
  ) {
    fail('invalid_input', 'leaseSeconds must be an integer between 15 and 300')
  }
  const canonicalComputedAt = parseTimestamp(computedAt, 'computedAt', 'invalid_input').canonical

  return Object.freeze({
    p_season_id: season as PublicationWindow,
    p_score_cohort_id: scoreCohortId,
    p_write_set_sha256: writeSetSha256,
    p_expected_rank_count: expectedRankCount as number,
    p_expected_batch_count: expectedBatchCount as number,
    p_computed_at: canonicalComputedAt,
    p_lease_seconds: leaseSeconds as number,
  })
}

function canonicalizeInput(input: unknown): ClaimRpcArgs {
  try {
    return canonicalizeInputUnsafe(input)
  } catch (error) {
    if (error instanceof ClaimRankGenerationError) throw error
    fail('invalid_input', 'generation claim input could not be read safely', { cause: error })
  }
}

function requireOptionsUnsafe(
  options: unknown,
  leaseSeconds: number
): {
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
} {
  if (
    !isRecord(options) ||
    !hasExactKeys(
      options,
      OPTION_KEYS.filter((key) => key in options)
    )
  ) {
    fail('invalid_input', 'generation claim options must contain only timeoutMs and signal')
  }
  const rawTimeoutMs = Reflect.get(options, 'timeoutMs')
  const rawSignal = Reflect.get(options, 'signal')
  const leaseBoundTimeoutMs = Math.floor(
    (leaseSeconds * 1000) / LEADERBOARD_RANK_GENERATION_CLAIM_LEASE_TIMEOUT_DIVISOR
  )
  const timeoutMs =
    rawTimeoutMs ?? Math.min(LEADERBOARD_RANK_GENERATION_CLAIM_RPC_TIMEOUT_MS, leaseBoundTimeoutMs)
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) <= 0 ||
    (timeoutMs as number) > LEADERBOARD_RANK_GENERATION_CLAIM_MAX_TIMEOUT_MS ||
    (timeoutMs as number) > leaseBoundTimeoutMs
  ) {
    fail(
      'invalid_input',
      `timeoutMs must be a positive safe integer no greater than ${Math.min(
        LEADERBOARD_RANK_GENERATION_CLAIM_MAX_TIMEOUT_MS,
        leaseBoundTimeoutMs
      )} for this lease`
    )
  }
  if (rawSignal !== undefined && !isAbortSignal(rawSignal)) {
    fail('invalid_input', 'signal must be a native AbortSignal')
  }
  return { timeoutMs: timeoutMs as number, signal: rawSignal as AbortSignal | undefined }
}

function requireOptions(
  options: unknown,
  leaseSeconds: number
): {
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
} {
  try {
    return requireOptionsUnsafe(options, leaseSeconds)
  } catch (error) {
    if (error instanceof ClaimRankGenerationError) throw error
    fail('invalid_input', 'generation claim options could not be read safely', { cause: error })
  }
}

function callClaimRpc(supabase: ClaimRpcClient, args: ClaimRpcArgs): PreparedRpcQuery {
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
    // The migration remains dormant until explicitly applied. Reflection keeps
    // generated production-attested Database types untouched before deploy.
    query = Reflect.apply(rpc, supabase, ['claim_leaderboard_rank_generation', args])
  } catch (error) {
    fail('rpc_call_error', 'claim_leaderboard_rank_generation failed before dispatch', {
      cause: error,
    })
  }
  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'claim_leaderboard_rank_generation returned no query')
  }

  let then: unknown
  let abortSignal: unknown
  try {
    then = Reflect.get(query, 'then')
    abortSignal = Reflect.get(query, 'abortSignal')
  } catch (error) {
    fail('rpc_call_error', 'claim_leaderboard_rank_generation returned an unreadable query', {
      cause: error,
    })
  }
  if (typeof then !== 'function') {
    fail('rpc_call_error', 'claim_leaderboard_rank_generation returned a non-awaitable query')
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

function prepareAwaitable(prepared: PreparedRpcQuery, signal: AbortSignal): PreparedAwaitable {
  if (!prepared.bindAbortSignal) {
    if (!prepared.directThen) {
      fail('rpc_call_error', 'generation claim query has no awaitable terminator')
    }
    return { then: prepared.directThen }
  }

  let awaitable: unknown
  try {
    awaitable = prepared.bindAbortSignal(signal)
  } catch (error) {
    fail('rpc_call_error', 'generation claim RPC could not attach its AbortSignal', {
      cause: error,
    })
  }
  if ((typeof awaitable !== 'object' && typeof awaitable !== 'function') || awaitable === null) {
    fail('rpc_call_error', 'generation claim AbortSignal binding returned no query')
  }
  if (awaitable === prepared.query) {
    if (!prepared.directThen) {
      fail('rpc_call_error', 'generation claim query lost its snapshotted then function')
    }
    return { then: prepared.directThen }
  }
  let then: unknown
  try {
    then = Reflect.get(awaitable, 'then')
  } catch (error) {
    fail('rpc_call_error', 'generation claim AbortSignal binding returned an unreadable query', {
      cause: error,
    })
  }
  if (typeof then !== 'function') {
    fail('rpc_call_error', 'generation claim AbortSignal binding returned a non-awaitable query')
  }
  return {
    then: (onfulfilled, onrejected) => Reflect.apply(then, awaitable, [onfulfilled, onrejected]),
  }
}

function dispatchAwaitable(awaitable: PreparedAwaitable): Promise<unknown> {
  let synchronousThrow = false
  let thrownValue: unknown
  const promise = new Promise<unknown>((resolve, reject) => {
    try {
      awaitable.then(resolve, reject)
    } catch (error) {
      synchronousThrow = true
      thrownValue = error
    }
  })
  if (synchronousThrow) {
    // The hostile thenable may already have rejected, or may retain and later
    // invoke the callback. Attach a sink before throwing the authoritative
    // ambiguous outcome so neither ordering can become an unhandled rejection.
    void promise.catch(() => undefined)
    throw new AmbiguousRpcAttemptError(
      'transport',
      'generation claim thenable threw across the dispatch boundary',
      {
        cause: thrownValue,
      }
    )
  }
  return promise
}

function failPreservingAmbiguity(ambiguity: AmbiguousRpcAttemptError, attemptCount: number): never {
  fail(
    ambiguity.reason === 'timeout' ? 'rpc_timeout' : 'rpc_ambiguous',
    `generation claim's initial ${ambiguity.reason} outcome remained unresolved after ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}`,
    { cause: ambiguity }
  )
}

async function runRpcAttempt(
  supabase: ClaimRpcClient,
  args: ClaimRpcArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<unknown> {
  if (externalSignal && readAbortSignalAborted(externalSignal)) {
    fail('rpc_aborted', 'leaderboard generation claim was aborted before dispatch')
  }

  const controller = new AbortController()
  const prepared = callClaimRpc(supabase, args)
  const awaitable = prepareAwaitable(prepared, controller.signal)
  let timedOut = false
  let externallyAborted = false
  let dispatched = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined

  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('leaderboard generation claim deadline exceeded'))
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        externallyAborted = true
        controller.abort()
        reject(new Error('leaderboard generation claim aborted by caller'))
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
    if (externallyAborted || (externalSignal && readAbortSignalAborted(externalSignal))) {
      return await interruption
    }
    dispatched = true
    return await Promise.race([dispatchAwaitable(awaitable), interruption])
  } catch (error) {
    if (!dispatched && error instanceof ClaimRankGenerationError) throw error
    if (externallyAborted) {
      if (!dispatched) {
        fail('rpc_aborted', 'leaderboard generation claim was aborted before dispatch', {
          cause: error,
        })
      }
      throw new AmbiguousRpcAttemptError(
        'transport',
        'leaderboard generation claim was aborted after dispatch; commit state is unknown',
        { cause: error }
      )
    }
    if (timedOut) {
      throw new AmbiguousRpcAttemptError(
        'timeout',
        `claim_leaderboard_rank_generation exceeded its ${timeoutMs}ms deadline`,
        { cause: error }
      )
    }
    throw new AmbiguousRpcAttemptError(
      'transport',
      'claim_leaderboard_rank_generation lost its response after dispatch',
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalAbortListener?.()
  }
}

function inspectEnvelope(response: unknown): RpcEnvelope {
  try {
    if (!isRecord(response)) {
      fail('rpc_error', 'generation claim RPC returned no envelope')
    }
    return {
      data: Reflect.get(response, 'data'),
      error: Reflect.get(response, 'error'),
      status: Reflect.get(response, 'status'),
    }
  } catch (error) {
    if (error instanceof ClaimRankGenerationError) throw error
    fail('rpc_error', 'generation claim RPC returned an unreadable envelope', { cause: error })
  }
}

type EnvelopeDisposition =
  | { readonly state: 'success' }
  | { readonly state: 'ambiguous' }
  | { readonly state: 'error'; readonly description: string }

function describeError(error: unknown): { readonly code: string | null; readonly text: string } {
  try {
    if (!isRecord(error)) return { code: null, text: String(error) }
    const rawCode = Reflect.get(error, 'code')
    const rawMessage = Reflect.get(error, 'message')
    const code = typeof rawCode === 'string' && rawCode.trim() !== '' ? rawCode : null
    return {
      code,
      text: `${typeof rawMessage === 'string' ? rawMessage : 'unknown RPC error'} (code=${
        code ?? 'unknown'
      })`,
    }
  } catch (cause) {
    fail('rpc_error', 'generation claim RPC returned an unreadable error', { cause })
  }
}

function inspectEnvelopeDisposition(envelope: RpcEnvelope): EnvelopeDisposition {
  const status = envelope.status
  const gatewayFailure = status === 502 || status === 503 || status === 504
  const ambiguousStatus = status === 0 || gatewayFailure

  if (envelope.error !== null && envelope.error !== undefined) {
    const described = describeError(envelope.error)
    if (ambiguousStatus && described.code === null) return { state: 'ambiguous' }
    return { state: 'error', description: described.text }
  }
  if (status === 0) return { state: 'ambiguous' }
  if (!Number.isInteger(status)) {
    return { state: 'error', description: 'response status is not a numeric HTTP status' }
  }
  if (gatewayFailure) return { state: 'ambiguous' }
  if ((status as number) < 200 || (status as number) >= 300) {
    return { state: 'error', description: `unexpected HTTP status ${String(status)}` }
  }
  return { state: 'success' }
}

function requireResponseInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('rpc_shape_mismatch', `${label} must be a safe integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function parseResponseUnsafe(data: unknown, args: ClaimRpcArgs): LeaderboardRankGenerationClaim {
  if (!isRecord(data) || !hasExactKeys(data, RESPONSE_KEYS)) {
    fail('rpc_shape_mismatch', 'generation claim RPC returned an invalid response shape')
  }

  const contract = Reflect.get(data, 'contract')
  const seasonId = Reflect.get(data, 'season_id')
  const scoreCohortId = Reflect.get(data, 'score_cohort_id')
  const rawGenerationSequence = Reflect.get(data, 'generation_seq')
  const phase = Reflect.get(data, 'phase')
  const writeSetSha256 = Reflect.get(data, 'write_set_sha256')
  const expectedRankCount = Reflect.get(data, 'expected_rank_count')
  const expectedBatchCount = Reflect.get(data, 'expected_batch_count')
  const rawComputedAt = Reflect.get(data, 'computed_at')
  const rawClaimedAt = Reflect.get(data, 'claimed_at')
  const rawLeaseExpiresAt = Reflect.get(data, 'lease_expires_at')
  const generationSequence = requireResponseInteger(
    rawGenerationSequence,
    'generation_seq',
    1,
    LEADERBOARD_RANK_GENERATION_MAX_SEQUENCE
  )
  const computedAt = parseTimestamp(rawComputedAt, 'computed_at', 'rpc_shape_mismatch')
  const claimedAt = parseTimestamp(rawClaimedAt, 'claimed_at', 'rpc_shape_mismatch')
  const leaseExpiresAt = parseTimestamp(rawLeaseExpiresAt, 'lease_expires_at', 'rpc_shape_mismatch')

  if (
    contract !== LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT ||
    seasonId !== args.p_season_id ||
    scoreCohortId !== args.p_score_cohort_id ||
    phase !== 'claimed' ||
    writeSetSha256 !== args.p_write_set_sha256 ||
    expectedRankCount !== args.p_expected_rank_count ||
    expectedBatchCount !== args.p_expected_batch_count ||
    computedAt.canonical !== args.p_computed_at ||
    rawComputedAt !== computedAt.canonical ||
    rawClaimedAt !== claimedAt.canonical ||
    rawLeaseExpiresAt !== leaseExpiresAt.canonical ||
    leaseExpiresAt.epochMicros - claimedAt.epochMicros !== BigInt(args.p_lease_seconds) * 1_000_000n
  ) {
    fail('rpc_shape_mismatch', 'generation claim response does not match the requested claim')
  }

  return Object.freeze({
    contract: LEADERBOARD_RANK_GENERATION_CLAIM_CONTRACT,
    season_id: args.p_season_id,
    score_cohort_id: args.p_score_cohort_id,
    generation_seq: generationSequence,
    phase: 'claimed',
    write_set_sha256: args.p_write_set_sha256,
    expected_rank_count: args.p_expected_rank_count,
    expected_batch_count: args.p_expected_batch_count,
    computed_at: computedAt.canonical,
    claimed_at: claimedAt.canonical,
    lease_expires_at: leaseExpiresAt.canonical,
  })
}

function parseResponse(data: unknown, args: ClaimRpcArgs): LeaderboardRankGenerationClaim {
  try {
    return parseResponseUnsafe(data, args)
  } catch (error) {
    if (error instanceof ClaimRankGenerationError) throw error
    fail('rpc_shape_mismatch', 'generation claim response could not be read safely', {
      cause: error,
    })
  }
}

/**
 * Claim one durable, monotonically fenced generation before any rank DML.
 * Only ambiguous transport outcomes are retried, with the exact same frozen
 * argument object; deterministic database failures are surfaced immediately.
 */
export async function claimLeaderboardRankGeneration(
  supabase: ClaimRpcClient,
  input: ClaimRankGenerationInput,
  options: ClaimRankGenerationOptions = {}
): Promise<LeaderboardRankGenerationClaim> {
  const args = canonicalizeInput(input)
  const { timeoutMs, signal } = requireOptions(options, args.p_lease_seconds)
  let firstAmbiguousError: AmbiguousRpcAttemptError | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let rawEnvelope: unknown
    try {
      rawEnvelope = await runRpcAttempt(supabase, args, timeoutMs, signal)
    } catch (error) {
      if (!(error instanceof AmbiguousRpcAttemptError)) {
        if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, attempt)
        throw error
      }
      firstAmbiguousError ??= error
      if (signal && readAbortSignalAborted(signal)) {
        failPreservingAmbiguity(firstAmbiguousError, attempt)
      }
      if (attempt === 1) continue
      failPreservingAmbiguity(firstAmbiguousError, attempt)
    }

    let envelope: RpcEnvelope
    let disposition: EnvelopeDisposition
    try {
      envelope = inspectEnvelope(rawEnvelope)
      disposition = inspectEnvelopeDisposition(envelope)
    } catch (error) {
      if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, attempt)
      throw error
    }
    if (disposition.state === 'ambiguous') {
      const ambiguity = new AmbiguousRpcAttemptError(
        'transport',
        `claim_leaderboard_rank_generation returned ambiguous status ${String(envelope.status)}`,
        { cause: envelope.error }
      )
      firstAmbiguousError ??= ambiguity
      if (signal && readAbortSignalAborted(signal)) {
        failPreservingAmbiguity(firstAmbiguousError, attempt)
      }
      if (attempt === 1) continue
      failPreservingAmbiguity(firstAmbiguousError, attempt)
    }
    if (disposition.state === 'error') {
      if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, attempt)
      fail('rpc_error', `generation claim RPC failed: ${disposition.description}`)
    }
    if (envelope.data === null || envelope.data === undefined) {
      if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, attempt)
      fail('rpc_null', 'generation claim RPC returned null data')
    }
    try {
      return parseResponse(envelope.data, args)
    } catch (error) {
      if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, attempt)
      throw error
    }
  }

  if (firstAmbiguousError) failPreservingAmbiguity(firstAmbiguousError, 2)
  fail('rpc_ambiguous', 'generation claim RPC did not produce a definitive response')
}
