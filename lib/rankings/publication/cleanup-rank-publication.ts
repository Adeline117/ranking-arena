import type { PublicationRpcClient } from './rpc-client'
import type { PublicationWindow, SourcePublicationRow } from './source-publication-evidence'

export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT =
  'leaderboard-rank-publication-cleanup@1'
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_RPC_TIMEOUT_MS = 30_000
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_TIMEOUT_MS = 60_000
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES = 256
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES = 250_000
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCE_LENGTH = 128
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH = 512
export const LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES = 64 * 1024 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const RFC3339_MICROSECOND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)?.get
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener

const SOURCE_PUBLICATION_KEYS = [
  'published_rank_count',
  'registry_slugs',
  'score_cohort_id',
  'snapshot_ids',
  'source',
  'source_as_of',
] as const

const CLEANUP_RESPONSE_KEYS = [
  'contract',
  'deleted_count',
  'kept_count',
  'score_cohort_id',
  'season_id',
  'source_count',
] as const

export type CleanupRankPublicationErrorCode =
  | 'invalid_input'
  | 'rpc_call_error'
  | 'rpc_error'
  | 'rpc_null'
  | 'rpc_shape_mismatch'
  | 'rpc_aborted'
  | 'rpc_timeout'
  | 'rpc_ambiguous'

export class CleanupRankPublicationError extends Error {
  constructor(
    public readonly code: CleanupRankPublicationErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'CleanupRankPublicationError'
  }
}

export interface CleanupRankPublicationInput {
  season: PublicationWindow
  scoreCohortId: string
  freshPublications: readonly SourcePublicationRow[]
  finalEligibleIdentityMap: ReadonlyMap<string, readonly string[]>
}

export interface CleanupRankPublicationOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface LeaderboardRankPublicationCleanupResult {
  contract: typeof LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT
  season_id: PublicationWindow
  score_cohort_id: string
  source_count: number
  kept_count: number
  deleted_count: number
}

interface StrictCleanupSourcePublicationPayload {
  readonly source: string
  readonly trader_ids: readonly string[]
}

interface CleanupRpcArgs {
  readonly p_season_id: PublicationWindow
  readonly p_score_cohort_id: string
  readonly p_source_publications: readonly StrictCleanupSourcePublicationPayload[]
}

interface SnapshottedSourcePublication {
  readonly source: string
  readonly source_as_of: string
  readonly published_rank_count: number
  readonly score_cohort_id: string
  readonly registry_slugs: readonly string[]
  readonly snapshot_ids: readonly number[]
}

interface SnapshottedIdentityMapEntry {
  readonly source: unknown
  readonly identities: unknown
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
  status?: unknown
}

interface PreparedRpcQuery {
  query: object | ((...args: never[]) => unknown)
  bindAbortSignal?: (signal: AbortSignal) => PromiseLike<RpcEnvelope>
  directThen?: (
    onfulfilled: (value: RpcEnvelope) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
}

type CleanupRpcClient = PublicationRpcClient

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
  code: CleanupRankPublicationErrorCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new CleanupRankPublicationError(code, message, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function exceedsPostgresJsonbRequestBound(
  sourcePublications: readonly StrictCleanupSourcePublicationPayload[]
): boolean {
  // The SQL fence measures `p_source_publications::text`, whose jsonb_out form
  // inserts one space after `:` and `,`. Count those exact UTF-8 bytes instead
  // of JSON.stringify's more compact transport representation.
  let bytes = 2 // outer `[]`
  for (let sourceIndex = 0; sourceIndex < sourcePublications.length; sourceIndex += 1) {
    if (sourceIndex > 0) bytes += 2 // `, ` between source objects
    const publication = sourcePublications[sourceIndex]
    bytes += Buffer.byteLength('{"source": ', 'utf8')
    bytes += Buffer.byteLength(JSON.stringify(publication.source), 'utf8')
    bytes += Buffer.byteLength(', "trader_ids": [', 'utf8')
    for (let identityIndex = 0; identityIndex < publication.trader_ids.length; identityIndex += 1) {
      if (identityIndex > 0) bytes += 2 // `, ` between jsonb array members
      bytes += Buffer.byteLength(JSON.stringify(publication.trader_ids[identityIndex]), 'utf8')
      if (bytes > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES) return true
    }
    bytes += 2 // `]}`
    if (bytes > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES) return true
  }
  return bytes > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_REQUEST_BYTES
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const sortedExpected = [...expected].sort(compareText)
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function snapshotArrayUnsafe(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail('invalid_input', `${label} must be an array`)
  }
  const length = Reflect.get(value, 'length')
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxLength) {
    fail('invalid_input', `${label} has an invalid length`)
  }

  const snapshot: unknown[] = []
  for (let index = 0; index < (length as number); index += 1) {
    snapshot.push(Reflect.get(value, String(index)))
  }
  return Object.freeze(snapshot)
}

function snapshotSourcePublicationUnsafe(value: unknown): SnapshottedSourcePublication {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_PUBLICATION_KEYS)) {
    fail('invalid_input', 'freshPublications contains a non-buildSourcePublicationRows row')
  }

  const source = Reflect.get(value, 'source')
  const sourceAsOf = Reflect.get(value, 'source_as_of')
  const publishedRankCount = Reflect.get(value, 'published_rank_count')
  const scoreCohortId = Reflect.get(value, 'score_cohort_id')
  const rawRegistrySlugs = Reflect.get(value, 'registry_slugs')
  const rawSnapshotIds = Reflect.get(value, 'snapshot_ids')

  if (
    typeof source !== 'string' ||
    typeof sourceAsOf !== 'string' ||
    typeof publishedRankCount !== 'number' ||
    typeof scoreCohortId !== 'string'
  ) {
    fail('invalid_input', 'freshPublications contains a non-buildSourcePublicationRows row')
  }

  const rawRegistrySlugSnapshot = snapshotArrayUnsafe(
    rawRegistrySlugs,
    `${source}.registry_slugs`,
    LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES
  )
  const rawSnapshotIdSnapshot = snapshotArrayUnsafe(
    rawSnapshotIds,
    `${source}.snapshot_ids`,
    LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES
  )
  if (
    rawRegistrySlugSnapshot.some((registrySlug) => typeof registrySlug !== 'string') ||
    rawSnapshotIdSnapshot.some((snapshotId) => typeof snapshotId !== 'number')
  ) {
    fail('invalid_input', 'freshPublications contains a non-buildSourcePublicationRows row')
  }

  return Object.freeze({
    source,
    source_as_of: sourceAsOf,
    published_rank_count: publishedRankCount,
    score_cohort_id: scoreCohortId,
    registry_slugs: rawRegistrySlugSnapshot as readonly string[],
    snapshot_ids: rawSnapshotIdSnapshot as readonly number[],
  })
}

function snapshotIdentityMapEntriesUnsafe(value: unknown): readonly SnapshottedIdentityMapEntry[] {
  if (!(value instanceof Map)) {
    fail('invalid_input', 'finalEligibleIdentityMap must be a ReadonlyMap')
  }

  // Invoke Map intrinsics with the same receiver. This avoids caller-defined
  // keys/get/size accessors and rejects Proxy or forged Map receivers at the
  // internal-slot brand check before any RPC can be constructed.
  const size = Reflect.get(Map.prototype, 'size', value)
  if (
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (size as number) > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES
  ) {
    fail('invalid_input', 'finalEligibleIdentityMap has an invalid size')
  }

  const entries: SnapshottedIdentityMapEntry[] = []
  Reflect.apply(Map.prototype.forEach, value, [
    (identities: unknown, source: unknown) => {
      entries.push(Object.freeze({ source, identities }))
    },
  ])
  if (entries.length !== size) {
    fail('invalid_input', 'finalEligibleIdentityMap changed while it was read')
  }
  return Object.freeze(entries)
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

function countValidUnicodeScalars(value: string): number | null {
  if (value.includes('\u0000')) return null
  let scalarCount = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return null
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null
    }
    scalarCount += 1
  }
  return scalarCount
}

function requireValidTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    fail('invalid_input', `${label} must be an RFC3339 timestamp`)
  }
  const match = RFC3339_MICROSECOND_PATTERN.exec(value)
  if (!match) {
    fail('invalid_input', `${label} must be an RFC3339 timestamp with timezone`)
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match
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

  if (zone !== 'Z') {
    const offsetHours = Number(match[10])
    const offsetMinutes = Number(match[11])
    if (offsetHours > 23 || offsetMinutes > 59) {
      fail('invalid_input', `${label} has an invalid timezone offset`)
    }
  }
}

function requirePublicationMetadata(publication: SnapshottedSourcePublication): void {
  if (
    publication.registry_slugs.length === 0 ||
    publication.registry_slugs.some(
      (registrySlug) => registrySlug.length === 0 || registrySlug !== registrySlug.trim()
    ) ||
    publication.snapshot_ids.length === 0 ||
    publication.snapshot_ids.some(
      (snapshotId) => !Number.isSafeInteger(snapshotId) || snapshotId <= 0
    )
  ) {
    fail('invalid_input', `${publication.source} publication evidence metadata is invalid`)
  }
}

function canonicalizeInputUnsafe(input: unknown): {
  args: CleanupRpcArgs
  sourceCount: number
  keptCount: number
} {
  if (!isRecord(input)) {
    fail('invalid_input', 'cleanup input must be an object')
  }

  // Snapshot each caller-controlled top-level property exactly once. All
  // validation and the eventual RPC args are derived only from these values.
  const season = Reflect.get(input, 'season')
  const scoreCohortId = Reflect.get(input, 'scoreCohortId')
  const rawFreshPublications = Reflect.get(input, 'freshPublications')
  const rawFinalEligibleIdentityMap = Reflect.get(input, 'finalEligibleIdentityMap')

  if (typeof season !== 'string' || !['7D', '30D', '90D'].includes(season)) {
    fail('invalid_input', 'season must be exactly 7D, 30D, or 90D')
  }
  if (typeof scoreCohortId !== 'string' || !UUID_PATTERN.test(scoreCohortId)) {
    fail('invalid_input', 'scoreCohortId must be a canonical lowercase UUID')
  }
  const freshPublicationSnapshot = snapshotArrayUnsafe(
    rawFreshPublications,
    'freshPublications',
    LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCES
  )
  if (freshPublicationSnapshot.length === 0) {
    fail('invalid_input', 'freshPublications must contain 1..256 source publications')
  }
  const rawIdentityEntries = snapshotIdentityMapEntriesUnsafe(rawFinalEligibleIdentityMap)

  const publicationsBySource = new Map<string, SnapshottedSourcePublication>()
  for (const rawPublication of freshPublicationSnapshot) {
    const publication = snapshotSourcePublicationUnsafe(rawPublication)
    if (
      publication.source.length > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_SOURCE_LENGTH ||
      !SOURCE_PATTERN.test(publication.source)
    ) {
      fail('invalid_input', 'freshPublications contains a non-canonical source')
    }
    if (publicationsBySource.has(publication.source)) {
      fail('invalid_input', `freshPublications contains duplicate source ${publication.source}`)
    }
    if (publication.score_cohort_id !== scoreCohortId) {
      fail('invalid_input', `${publication.source} publication cohort does not match caller cohort`)
    }
    if (
      !Number.isSafeInteger(publication.published_rank_count) ||
      publication.published_rank_count < 0
    ) {
      fail(
        'invalid_input',
        `${publication.source}.published_rank_count must be a non-negative safe integer`
      )
    }
    requireValidTimestamp(publication.source_as_of, `${publication.source}.source_as_of`)
    requirePublicationMetadata(publication)
    publicationsBySource.set(publication.source, publication)
  }

  const identitySnapshotsBySource = new Map<string, readonly unknown[]>()
  let snapshottedIdentityCount = 0
  for (const entry of rawIdentityEntries) {
    if (typeof entry.source !== 'string' || !publicationsBySource.has(entry.source)) {
      fail('invalid_input', 'finalEligibleIdentityMap contains a non-fresh source')
    }
    const identitySnapshot = snapshotArrayUnsafe(
      entry.identities,
      `${entry.source}.finalEligibleIdentities`,
      LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES - snapshottedIdentityCount
    )
    snapshottedIdentityCount += identitySnapshot.length
    identitySnapshotsBySource.set(entry.source, identitySnapshot)
  }

  let keptCount = 0
  const sourcePublications = [...publicationsBySource.values()]
    .sort((left, right) => compareText(left.source, right.source))
    .map((publication): StrictCleanupSourcePublicationPayload => {
      const rawIdentities = identitySnapshotsBySource.get(publication.source)
      if (rawIdentities === undefined) {
        fail('invalid_input', `${publication.source} final eligible identities were omitted`)
      }

      const identitySet = new Set<string>()
      for (const identity of rawIdentities) {
        const scalarCount = typeof identity === 'string' ? countValidUnicodeScalars(identity) : null
        if (
          typeof identity !== 'string' ||
          identity.length === 0 ||
          identity !== identity.trim() ||
          scalarCount === null ||
          scalarCount > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITY_LENGTH
        ) {
          fail('invalid_input', `${publication.source} contains an invalid trader identity`)
        }
        if (identitySet.has(identity)) {
          fail('invalid_input', `${publication.source} contains a duplicate trader identity`)
        }
        identitySet.add(identity)
        if (identitySet.size > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES) {
          fail('invalid_input', 'cleanup publication exceeds the trader identity bound')
        }
      }

      const traderIds = [...identitySet].sort(compareUtf8)
      if (traderIds.length !== publication.published_rank_count) {
        fail(
          'invalid_input',
          `${publication.source} eligible identity count does not match publication count`
        )
      }
      keptCount += traderIds.length
      if (keptCount > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_IDENTITIES) {
        fail('invalid_input', 'cleanup publication exceeds the trader identity bound')
      }

      return Object.freeze({
        source: publication.source,
        trader_ids: Object.freeze(traderIds),
      })
    })

  if (sourcePublications.length !== identitySnapshotsBySource.size) {
    fail('invalid_input', 'fresh publication sources and identity-map sources do not match')
  }
  if (exceedsPostgresJsonbRequestBound(sourcePublications)) {
    fail('invalid_input', 'cleanup source publication request exceeds 64 MiB')
  }

  const args = Object.freeze({
    p_season_id: season as PublicationWindow,
    p_score_cohort_id: scoreCohortId,
    p_source_publications: Object.freeze(sourcePublications),
  })
  return { args, sourceCount: sourcePublications.length, keptCount }
}

function canonicalizeInput(input: unknown): {
  args: CleanupRpcArgs
  sourceCount: number
  keptCount: number
} {
  try {
    return canonicalizeInputUnsafe(input)
  } catch (error) {
    if (error instanceof CleanupRankPublicationError) throw error
    fail('invalid_input', 'cleanup input could not be read safely', { cause: error })
  }
}

function requireOptions(options: unknown): {
  timeoutMs: number
  signal: AbortSignal | undefined
} {
  try {
    if (!isRecord(options)) {
      fail('invalid_input', 'cleanup options must be an object')
    }
    // Read caller-controlled accessors exactly once. Re-reading a stateful
    // getter after validation could substitute an unvalidated AbortSignal or
    // timeout before the RPC is dispatched.
    const rawTimeoutMs = Reflect.get(options, 'timeoutMs')
    const rawSignal = Reflect.get(options, 'signal')
    const timeoutMs = rawTimeoutMs ?? LEADERBOARD_RANK_PUBLICATION_CLEANUP_RPC_TIMEOUT_MS
    if (
      !Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) <= 0 ||
      (timeoutMs as number) > LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_TIMEOUT_MS
    ) {
      fail(
        'invalid_input',
        `timeoutMs must be a positive safe integer no greater than ${LEADERBOARD_RANK_PUBLICATION_CLEANUP_MAX_TIMEOUT_MS}`
      )
    }
    if (rawSignal !== undefined && !isAbortSignal(rawSignal)) {
      fail('invalid_input', 'signal must be an AbortSignal')
    }
    return { timeoutMs: timeoutMs as number, signal: rawSignal as AbortSignal | undefined }
  } catch (error) {
    if (error instanceof CleanupRankPublicationError) throw error
    fail('invalid_input', 'cleanup options could not be read safely', { cause: error })
  }
}

function inspectRpcEnvelope(response: unknown): RpcEnvelope {
  try {
    if (!isRecord(response)) {
      fail('rpc_error', 'cleanup RPC returned no envelope')
    }
    return {
      data: Reflect.get(response, 'data'),
      error: Reflect.get(response, 'error'),
      status: Reflect.get(response, 'status'),
    }
  } catch (error) {
    if (error instanceof CleanupRankPublicationError) throw error
    fail('rpc_error', 'cleanup RPC returned an unreadable envelope', { cause: error })
  }
}

type RpcEnvelopeDisposition =
  | { readonly state: 'ambiguous' }
  | { readonly state: 'error'; readonly description: string }
  | { readonly state: 'success' }

function inspectRpcEnvelopeDisposition(envelope: RpcEnvelope): RpcEnvelopeDisposition {
  if (envelope.status === 0) return { state: 'ambiguous' }

  const isGatewayFailure = [502, 503, 504].includes(envelope.status as number)
  if (envelope.error === null || envelope.error === undefined) {
    return isGatewayFailure ? { state: 'ambiguous' } : { state: 'success' }
  }

  try {
    if (!isRecord(envelope.error)) {
      return isGatewayFailure
        ? { state: 'ambiguous' }
        : { state: 'error', description: String(envelope.error) }
    }

    // Snapshot nested error fields once as well. A stateful code getter must
    // not classify as deterministic and then describe a different value.
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
    fail('rpc_error', 'cleanup RPC returned an unreadable error envelope', { cause: error })
  }
}

function callCleanupRpc(supabase: CleanupRpcClient, args: CleanupRpcArgs): PreparedRpcQuery {
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
    // This client remains dormant until the cleanup migration is deployed. The
    // reflective call intentionally does not modify generated Database types.
    query = Reflect.apply(rpc, supabase, ['cleanup_leaderboard_rank_publication', args])
  } catch (error) {
    fail('rpc_call_error', 'cleanup_leaderboard_rank_publication call failed before dispatch', {
      cause: error,
    })
  }
  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    fail('rpc_call_error', 'cleanup_leaderboard_rank_publication returned no query')
  }

  let then: unknown
  let abortSignal: unknown
  try {
    then = Reflect.get(query, 'then')
    abortSignal = Reflect.get(query, 'abortSignal')
  } catch (error) {
    fail('rpc_call_error', 'cleanup_leaderboard_rank_publication returned an unreadable query', {
      cause: error,
    })
  }
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    fail('rpc_call_error', 'cleanup_leaderboard_rank_publication returned a non-awaitable query')
  }

  return {
    query,
    bindAbortSignal:
      typeof abortSignal === 'function'
        ? (signal) => Reflect.apply(abortSignal, query, [signal]) as PromiseLike<RpcEnvelope>
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
  value: object | ((...args: never[]) => unknown)
  then: (
    onfulfilled: (value: RpcEnvelope) => void,
    onrejected: (reason: unknown) => void
  ) => unknown
} {
  if (!prepared.bindAbortSignal) {
    if (!prepared.directThen) {
      fail('rpc_call_error', 'cleanup RPC query has no awaitable terminator')
    }
    return { value: prepared.query, then: prepared.directThen }
  }

  let awaitable: unknown
  try {
    awaitable = prepared.bindAbortSignal(signal)
  } catch (error) {
    fail('rpc_call_error', 'cleanup RPC could not attach its AbortSignal before dispatch', {
      cause: error,
    })
  }
  if ((typeof awaitable !== 'object' && typeof awaitable !== 'function') || awaitable === null) {
    fail('rpc_call_error', 'cleanup RPC AbortSignal binding returned no query')
  }

  let then: unknown
  try {
    then = Reflect.get(awaitable, 'then')
  } catch (error) {
    fail('rpc_call_error', 'cleanup RPC AbortSignal binding returned an unreadable query', {
      cause: error,
    })
  }
  if (typeof then !== 'function') {
    fail('rpc_call_error', 'cleanup RPC AbortSignal binding returned a non-awaitable query')
  }
  return {
    value: awaitable,
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
    fail('rpc_call_error', 'cleanup RPC thenable threw before it could be awaited', {
      cause: thrownValue,
    })
  }
  return promise
}

async function runRpcAttempt(
  supabase: CleanupRpcClient,
  args: CleanupRpcArgs,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<RpcEnvelope> {
  if (externalSignal && readAbortSignalAborted(externalSignal)) {
    fail('rpc_aborted', 'leaderboard publication cleanup was aborted before dispatch')
  }

  const controller = new AbortController()
  const prepared = callCleanupRpc(supabase, args)
  const awaitable = prepareAwaitable(prepared, controller.signal)
  let timedOut = false
  let externallyAborted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeExternalAbortListener: (() => void) | undefined

  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('leaderboard publication cleanup deadline exceeded'))
    }, timeoutMs)

    if (externalSignal) {
      const onAbort = () => {
        externallyAborted = true
        controller.abort()
        reject(new Error('leaderboard publication cleanup aborted by caller'))
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
    if (error instanceof CleanupRankPublicationError) throw error
    if (externallyAborted) {
      fail('rpc_aborted', 'leaderboard publication cleanup was aborted by caller', { cause: error })
    }
    if (timedOut) {
      throw new AmbiguousRpcAttemptError(
        'timeout',
        `cleanup_leaderboard_rank_publication exceeded its ${timeoutMs}ms deadline`,
        { cause: error }
      )
    }
    throw new AmbiguousRpcAttemptError(
      'transport',
      'cleanup_leaderboard_rank_publication lost its response after dispatch',
      { cause: error }
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeExternalAbortListener?.()
  }
}

function requireResponseCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('rpc_shape_mismatch', `${label} must be a non-negative safe integer`)
  }
  return value as number
}

function parseCleanupResponseUnsafe(
  data: unknown,
  args: CleanupRpcArgs,
  sourceCount: number,
  keptCount: number
): LeaderboardRankPublicationCleanupResult {
  if (!isRecord(data) || !hasExactKeys(data, CLEANUP_RESPONSE_KEYS)) {
    fail('rpc_shape_mismatch', 'cleanup RPC returned an invalid response shape')
  }

  const contract = Reflect.get(data, 'contract')
  const seasonId = Reflect.get(data, 'season_id')
  const scoreCohortId = Reflect.get(data, 'score_cohort_id')
  const actualSourceCount = Reflect.get(data, 'source_count')
  const actualKeptCount = Reflect.get(data, 'kept_count')
  const rawDeletedCount = Reflect.get(data, 'deleted_count')
  if (
    contract !== LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT ||
    seasonId !== args.p_season_id ||
    scoreCohortId !== args.p_score_cohort_id ||
    actualSourceCount !== sourceCount ||
    actualKeptCount !== keptCount
  ) {
    fail('rpc_shape_mismatch', 'cleanup RPC response does not match the requested publication')
  }
  const deletedCount = requireResponseCount(rawDeletedCount, 'deleted_count')
  return {
    contract: LEADERBOARD_RANK_PUBLICATION_CLEANUP_CONTRACT,
    season_id: args.p_season_id,
    score_cohort_id: args.p_score_cohort_id,
    source_count: sourceCount,
    kept_count: keptCount,
    deleted_count: deletedCount,
  }
}

function parseCleanupResponse(
  data: unknown,
  args: CleanupRpcArgs,
  sourceCount: number,
  keptCount: number
): LeaderboardRankPublicationCleanupResult {
  try {
    return parseCleanupResponseUnsafe(data, args, sourceCount, keptCount)
  } catch (error) {
    if (error instanceof CleanupRankPublicationError) throw error
    fail('rpc_shape_mismatch', 'cleanup RPC response could not be read safely', { cause: error })
  }
}

/**
 * Delete stale rank rows for one already-written cohort before its terminal
 * rerank/seal. The RPC is idempotent for a canonical season/cohort/source set,
 * so one lost response is replayed with the exact same frozen argument object.
 */
export async function cleanupLeaderboardRankPublication(
  supabase: CleanupRpcClient,
  input: CleanupRankPublicationInput,
  options: CleanupRankPublicationOptions = {}
): Promise<LeaderboardRankPublicationCleanupResult> {
  const { args, sourceCount, keptCount } = canonicalizeInput(input)
  const { timeoutMs, signal } = requireOptions(options)
  let lastAmbiguousError: AmbiguousRpcAttemptError | undefined

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: RpcEnvelope
    try {
      response = await runRpcAttempt(supabase, args, timeoutMs, signal)
    } catch (error) {
      if (!(error instanceof AmbiguousRpcAttemptError)) throw error
      lastAmbiguousError = error
      if (signal && readAbortSignalAborted(signal)) {
        fail('rpc_aborted', 'leaderboard publication cleanup was aborted by caller', {
          cause: error,
        })
      }
      if (attempt === 1) continue
      fail(
        error.reason === 'timeout' ? 'rpc_timeout' : 'rpc_ambiguous',
        `cleanup RPC remained ambiguous after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        { cause: error }
      )
    }

    const envelope = inspectRpcEnvelope(response)
    const disposition = inspectRpcEnvelopeDisposition(envelope)
    if (disposition.state === 'ambiguous') {
      const transportError = new AmbiguousRpcAttemptError(
        'transport',
        `cleanup_leaderboard_rank_publication returned ambiguous transport status ${String(
          envelope.status
        )}`,
        { cause: envelope.error }
      )
      lastAmbiguousError = transportError
      if (signal && readAbortSignalAborted(signal)) {
        fail('rpc_aborted', 'leaderboard publication cleanup was aborted by caller', {
          cause: transportError,
        })
      }
      if (attempt === 1) continue
      fail(
        'rpc_ambiguous',
        `cleanup RPC remained ambiguous after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        { cause: transportError }
      )
    }
    if (disposition.state === 'error') {
      fail('rpc_error', `cleanup RPC failed: ${disposition.description}`)
    }
    if (envelope.data === null || envelope.data === undefined) {
      fail('rpc_null', 'cleanup RPC returned null data')
    }
    return parseCleanupResponse(envelope.data, args, sourceCount, keptCount)
  }

  fail('rpc_ambiguous', 'cleanup RPC did not produce a definitive response', {
    cause: lastAmbiguousError,
  })
}
