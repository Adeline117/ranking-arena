import type { SourceAdapter } from '@/lib/ingest/core/adapter'
import type { HistoryKind, SourceRow } from '@/lib/ingest/core/types'
import { getIngestPool, type IngestQueryExecutor } from '@/lib/ingest/db'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import {
  captureHistoryAcquisition,
  type HistoryAcquisitionArtifact,
} from '@/lib/ingest/history-acquisition'
import {
  type IngestTransactionRunner,
  prepareHistoryRawArtifactReconciliationExpectation,
  type RawObjectReceipt,
  type WriteHistoryRawArtifactInput,
  writeHistoryRawArtifact,
} from '@/lib/ingest/raw'
import {
  buildReviewedPositionHistoryEvidence,
  reviewedPositionHistoryContract,
} from '@/lib/ingest/reviewed-position-history'
import { strictCanonicalJson } from '@/lib/ingest/strict-canonical-json'
import {
  prepareVerifiedPositionHistoryPublication,
  prepareVerifiedPositionHistoryRpcCall,
  type PreparedVerifiedPositionHistoryPublication,
  type VerifiedPositionHistoryPublicationReceipt,
  validateVerifiedPositionHistoryPublicationReceipt,
} from '@/lib/ingest/verified-position-history'
import { getHistoryTransactionFailure, runHistoryTransaction } from './history-transaction'

const RECONCILABLE_DATABASE_CODES = new Set(['23505', '40001'])
const TRANSIENT_DATABASE_CODES = new Set([
  '40P01',
  '53300',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  'EAI_AGAIN',
  'ECHECKOUTTIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDBHANDLEREXITED',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
])
const RECONCILE_RETRY_DELAYS_MS = Object.freeze([0, 25, 100] as const)

const VERIFIED_POSITION_HISTORY_HEAD_SQL = `
  SELECT publication.publication_id,
         publication.cursor_after
    FROM arena.position_history_publications AS publication
   WHERE publication.source_id = $1
     AND publication.trader_id = $2
   ORDER BY publication.publication_id DESC
   LIMIT 1
` as const

const VERIFIED_POSITION_HISTORY_RECONCILE_SQL = `
  SELECT publication.publication_id,
         publication.previous_publication_id,
         publication.parsed_row_count,
         publication.row_set_sha256,
         publication.publication_sha256,
         publication.publication_payload,
         acquisition.raw_object_id,
         pg_catalog.jsonb_build_object(
           'cursorAfter', publication.cursor_after,
           'factsAdded', 0,
           'factsReused', publication.parsed_row_count,
           'observedAt', publication.observed_at,
           'publicationId', publication.publication_id,
           'publicationSha256', publication.publication_sha256,
           'rawObjectId', acquisition.raw_object_id,
           'replayed', true,
           'sourceRunId', publication.source_run_id,
           'stateId', publication.publication_id
         ) AS receipt
    FROM arena.position_history_publications AS publication
    JOIN arena.position_history_acquisitions AS acquisition
      ON acquisition.acquisition_id = publication.acquisition_id
   WHERE publication.source_run_id = $1
   LIMIT 2
` as const

const HISTORY_RAW_RECONCILE_SQL = `
  SELECT id, source_id, job_type, trader_id, timeframe,
         fetched_at, storage_path, bytes, content_hash, quarantined, meta,
         source_run_id, trust_artifact_role
    FROM arena.raw_objects
   WHERE source_run_id = $1
     AND trust_artifact_role = 'event_history'
   ORDER BY id
   LIMIT 2
` as const

interface PositionHistoryHeadRow {
  publication_id: unknown
  cursor_after: unknown
}

interface PositionHistoryReconciliationRow {
  publication_id: unknown
  previous_publication_id: unknown
  parsed_row_count: unknown
  row_set_sha256: unknown
  publication_sha256: unknown
  publication_payload: unknown
  raw_object_id: unknown
  receipt: unknown
}

interface HistoryRawReconciliationRow {
  id: unknown
  source_id: unknown
  job_type: unknown
  trader_id: unknown
  timeframe: unknown
  fetched_at: unknown
  storage_path: unknown
  bytes: unknown
  content_hash: unknown
  quarantined: unknown
  meta: unknown
  source_run_id: unknown
  trust_artifact_role: unknown
}

export interface VerifiedPositionHistoryHead {
  readonly cursor: string | null
  readonly publicationId: number | null
}

export interface VerifiedPositionHistoryPublisherRuntime {
  readonly database: IngestQueryExecutor
  readonly runTransaction: IngestTransactionRunner
  readonly writeRawArtifact: typeof writeHistoryRawArtifact
}

export interface CaptureAndPublishVerifiedPositionHistoryInput {
  readonly adapter: SourceAdapter
  readonly session: FetchSession
  readonly source: SourceRow
  readonly trader: Readonly<{
    id: number
    exchange_trader_id: string
    meta: Record<string, unknown> | null
  }>
}

export interface CaptureAndPublishVerifiedPositionHistoryResult {
  readonly rawObject: RawObjectReceipt
  readonly receipt: VerifiedPositionHistoryPublicationReceipt
}

function publisherError(detail: string): Error {
  return new Error(`[verified-position-history-publisher] ${detail}`)
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    Object.is(value, -0)
  ) {
    throw publisherError(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw publisherError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function normalizedTimestamp(value: unknown, label: string): string {
  const epochMs = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(epochMs)) throw publisherError(`${label} must be a database timestamp`)
  return new Date(epochMs).toISOString()
}

function databaseCode(cause: unknown): string | null {
  if (cause !== null && typeof cause === 'object') {
    const code = Reflect.get(cause, 'code')
    if (typeof code === 'string') return code
  }
  const failure = getHistoryTransactionFailure(cause)
  if (failure && failure.primaryCause !== cause) return databaseCode(failure.primaryCause)
  return null
}

function isExplicitTransientFailure(cause: unknown): boolean {
  const code = databaseCode(cause)
  return code !== null && (code.startsWith('08') || TRANSIENT_DATABASE_CODES.has(code))
}

async function boundedReconciliation<T>(lookup: () => Promise<T | null>): Promise<T | null> {
  let lastTransientFailure: unknown = null
  for (let attempt = 0; attempt < RECONCILE_RETRY_DELAYS_MS.length; attempt += 1) {
    const delayMs = RECONCILE_RETRY_DELAYS_MS[attempt]
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      const result = await lookup()
      lastTransientFailure = null
      if (result !== null) return result
    } catch (cause) {
      if (!isExplicitTransientFailure(cause)) throw cause
      lastTransientFailure = cause
    }
  }
  if (lastTransientFailure !== null) throw lastTransientFailure
  return null
}

function defaultRuntime(): VerifiedPositionHistoryPublisherRuntime {
  return {
    database: getIngestPool(),
    runTransaction: runHistoryTransaction,
    writeRawArtifact: writeHistoryRawArtifact,
  }
}

/**
 * Publication is enabled only for the exact reviewed source/adapter pairs.
 * Every other position-history surface remains immutable RAW evidence only.
 */
export function canPublishVerifiedPositionHistory(
  source: Pick<SourceRow, 'slug' | 'adapter_slug'>
): boolean {
  try {
    reviewedPositionHistoryContract(source.slug, source.adapter_slug)
    return true
  } catch {
    return false
  }
}

/**
 * Read the only cursor that may seed a verified incremental acquisition. A
 * legacy ingest_cursors value is deliberately never consulted here.
 */
export async function readVerifiedPositionHistoryHead(
  database: IngestQueryExecutor,
  sourceId: number,
  traderId: number
): Promise<VerifiedPositionHistoryHead> {
  positiveSafeInteger(sourceId, 'source id')
  positiveSafeInteger(traderId, 'trader id')
  const { rows } = await database.query<PositionHistoryHeadRow>(
    VERIFIED_POSITION_HISTORY_HEAD_SQL,
    [sourceId, traderId]
  )
  if (rows.length === 0) return Object.freeze({ cursor: null, publicationId: null })
  if (rows.length !== 1) throw publisherError('verified head query returned an inexact row count')

  const row = rows[0]
  const publicationId = positiveSafeInteger(row.publication_id, 'head publication id')
  const cursor =
    row.cursor_after === null
      ? null
      : normalizedTimestamp(row.cursor_after, 'head canonical cursor')
  return Object.freeze({ cursor, publicationId })
}

async function reconcileRawObject(
  database: IngestQueryExecutor,
  input: WriteHistoryRawArtifactInput
): Promise<RawObjectReceipt | null> {
  const { artifact, sourceRunId } = input
  const { rows } = await database.query<HistoryRawReconciliationRow>(HISTORY_RAW_RECONCILE_SQL, [
    sourceRunId,
  ])
  if (rows.length === 0) return null
  if (rows.length !== 1) throw publisherError('RAW source run is not globally unique')

  const row = rows[0]
  const durableCompressedBytes = positiveSafeInteger(row.bytes, 'RAW compressed byte count')
  const expected = prepareHistoryRawArtifactReconciliationExpectation(input, durableCompressedBytes)
  let metaCanonicalJson: string
  try {
    metaCanonicalJson = strictCanonicalJson(row.meta)
  } catch {
    throw publisherError('RAW source-run reconciliation metadata is not canonical JSON')
  }
  if (
    row.source_id !== artifact.source.id ||
    row.job_type !== `history:${artifact.history_kind}` ||
    row.trader_id !== artifact.trader.id ||
    row.timeframe !== null ||
    normalizedTimestamp(row.fetched_at, 'RAW fetched at') !== expected.fetchedAt ||
    row.storage_path !== expected.storagePath ||
    durableCompressedBytes !== expected.bytes ||
    row.content_hash !== sourceRunId ||
    row.quarantined !== false ||
    !expected.metaCandidatesCanonicalJson.includes(metaCanonicalJson) ||
    row.source_run_id !== sourceRunId ||
    row.trust_artifact_role !== 'event_history'
  ) {
    throw publisherError('RAW source-run reconciliation does not match the captured artifact')
  }
  return Object.freeze({
    id: positiveSafeInteger(row.id, 'RAW object id'),
    storagePath: expected.storagePath,
    contentHash: expected.contentHash,
  })
}

/**
 * Phase one: make the immutable RAW object and pointer independently durable.
 * A lost COMMIT response is reconciled first and may replay the exact same
 * content-addressed input at most once. A known-committed transaction is
 * reconciliation-only.
 */
export async function persistHistoryRawArtifactFirst(
  input: WriteHistoryRawArtifactInput,
  runtime: VerifiedPositionHistoryPublisherRuntime = defaultRuntime()
): Promise<RawObjectReceipt> {
  const writeOnce = () => runtime.writeRawArtifact(input, runtime.runTransaction)
  try {
    return await writeOnce()
  } catch (cause) {
    const failure = getHistoryTransactionFailure(cause)
    if (failure?.outcome === 'committed' || failure?.outcome === 'ambiguous') {
      const reconciled = await boundedReconciliation(() =>
        reconcileRawObject(runtime.database, input)
      )
      if (reconciled !== null) return reconciled
    }
    const exactReplayAllowed =
      failure?.replayPolicy === 'exact_input_only' ||
      (failure?.outcome === 'not_committed' && isExplicitTransientFailure(cause))
    if (!exactReplayAllowed) throw cause

    try {
      return await writeOnce()
    } catch (replayCause) {
      const replayFailure = getHistoryTransactionFailure(replayCause)
      if (replayFailure?.outcome === 'committed' || replayFailure?.outcome === 'ambiguous') {
        const reconciled = await boundedReconciliation(() =>
          reconcileRawObject(runtime.database, input)
        )
        if (reconciled !== null) return reconciled
      }
      throw replayCause
    }
  }
}

async function executePreparedPublication(
  publication: PreparedVerifiedPositionHistoryPublication,
  runtime: VerifiedPositionHistoryPublisherRuntime,
  rpcCall: ReturnType<typeof prepareVerifiedPositionHistoryRpcCall>
): Promise<VerifiedPositionHistoryPublicationReceipt> {
  return runtime.runTransaction(async (transaction) => {
    const result = await transaction.query<{ receipt: unknown }>(rpcCall.text, rpcCall.values)
    if (result.rows.length !== 1) {
      throw publisherError('publication RPC returned an inexact receipt row count')
    }
    return validateBoundPublicationReceipt(publication, result.rows[0].receipt)
  })
}

function validateBoundPublicationReceipt(
  publication: PreparedVerifiedPositionHistoryPublication,
  value: unknown
): VerifiedPositionHistoryPublicationReceipt {
  const receipt = validateVerifiedPositionHistoryPublicationReceipt(publication, value)
  if (receipt.stateId !== receipt.publicationId) {
    throw publisherError('publication receipt state is not bound to its publication')
  }
  return receipt
}

async function reconcilePreparedPublication(
  publication: PreparedVerifiedPositionHistoryPublication,
  runtime: VerifiedPositionHistoryPublisherRuntime,
  rpcCall: ReturnType<typeof prepareVerifiedPositionHistoryRpcCall>
): Promise<VerifiedPositionHistoryPublicationReceipt | null> {
  const { rows } = await runtime.database.query<PositionHistoryReconciliationRow>(
    VERIFIED_POSITION_HISTORY_RECONCILE_SQL,
    [publication.sourceRunId]
  )
  if (rows.length === 0) return null
  if (rows.length !== 1) throw publisherError('publication source run is not globally unique')

  const row = rows[0]
  const publicationId = positiveSafeInteger(row.publication_id, 'reconciled publication id')
  const previousPublicationId =
    row.previous_publication_id === null
      ? null
      : positiveSafeInteger(row.previous_publication_id, 'reconciled previous publication id')
  const parsedRowCount = nonNegativeSafeInteger(row.parsed_row_count, 'reconciled parsed row count')
  if (
    previousPublicationId !== publication.previousPublicationId ||
    parsedRowCount !== publication.rows.length ||
    row.row_set_sha256 !== publication.rowSetSha256 ||
    row.publication_sha256 !== publication.publicationSha256 ||
    row.publication_payload !== rpcCall.values[3] ||
    row.raw_object_id !== publication.rawObjectId
  ) {
    throw publisherError('immutable source-run reconciliation does not match the prepared call')
  }

  const receipt = validateBoundPublicationReceipt(publication, row.receipt)
  if (receipt.publicationId !== publicationId || receipt.stateId !== publicationId) {
    throw publisherError('reconciled receipt is not bound to its publication state')
  }
  return receipt
}

/**
 * Phase two: invoke the postgres-owner authority with one immutable prepared
 * call. Ambiguous COMMIT may reconcile and replay that exact call once; stale
 * head (40001), identity conflict (23505), and known-committed outcomes never
 * rebase or mint a new payload.
 */
export async function publishPreparedVerifiedPositionHistory(
  publication: PreparedVerifiedPositionHistoryPublication,
  runtime: VerifiedPositionHistoryPublisherRuntime = defaultRuntime()
): Promise<VerifiedPositionHistoryPublicationReceipt> {
  // The preparation boundary returns a frozen text/value tuple. Construct it
  // once so every ambiguity path sends byte-for-byte identical values.
  const rpcCall = prepareVerifiedPositionHistoryRpcCall(publication)
  try {
    return await executePreparedPublication(publication, runtime, rpcCall)
  } catch (cause) {
    const failure = getHistoryTransactionFailure(cause)
    const code = databaseCode(cause)

    if (
      failure?.outcome === 'committed' ||
      failure?.outcome === 'ambiguous' ||
      (code !== null && RECONCILABLE_DATABASE_CODES.has(code))
    ) {
      const reconciled = await boundedReconciliation(() =>
        reconcilePreparedPublication(publication, runtime, rpcCall)
      )
      if (reconciled !== null) return reconciled
    }

    // Outcome-ambiguous COMMIT and explicitly transient not-committed errors
    // authorize one exact replay. A stale 40001 is deliberately not retried
    // with a newly-read head or cursor.
    const exactReplayAllowed =
      failure?.replayPolicy === 'exact_input_only' ||
      (failure?.outcome === 'not_committed' && isExplicitTransientFailure(cause))
    if (!exactReplayAllowed) throw cause

    try {
      return await executePreparedPublication(publication, runtime, rpcCall)
    } catch (replayCause) {
      const replayFailure = getHistoryTransactionFailure(replayCause)
      const replayCode = databaseCode(replayCause)
      if (
        replayFailure?.outcome === 'committed' ||
        replayFailure?.outcome === 'ambiguous' ||
        (replayCode !== null && RECONCILABLE_DATABASE_CODES.has(replayCode))
      ) {
        const reconciled = await boundedReconciliation(() =>
          reconcilePreparedPublication(publication, runtime, rpcCall)
        )
        if (reconciled !== null) return reconciled
      }
      throw replayCause
    }
  }
}

/**
 * Keep the large reviewed candidate graph in a synchronous inner scope. Once
 * this helper returns, only the independently prepared/frozen facts and wire
 * call remain reachable across the database await.
 */
function preparePublicationAfterRaw(
  artifact: HistoryAcquisitionArtifact,
  sourceRunId: string,
  previousPublicationId: number | null,
  rawObject: RawObjectReceipt,
  source: SourceRow
): PreparedVerifiedPositionHistoryPublication {
  const evidence = buildReviewedPositionHistoryEvidence(artifact, sourceRunId)
  return prepareVerifiedPositionHistoryPublication({
    acquisition: evidence.artifact,
    previousPublicationId,
    rawObject,
    rows: evidence.canonicalRows,
    source,
    sourceRunId,
  })
}

/**
 * Complete Tier-B position-history flow. The verified head is captured before
 * upstream I/O, RAW commits as an independent first phase, and only the shared
 * reviewed parser output can enter the owner-only publication transaction.
 */
export async function captureAndPublishVerifiedPositionHistory(
  input: CaptureAndPublishVerifiedPositionHistoryInput,
  runtime: VerifiedPositionHistoryPublisherRuntime = defaultRuntime()
): Promise<CaptureAndPublishVerifiedPositionHistoryResult> {
  if (!canPublishVerifiedPositionHistory(input.source)) {
    throw publisherError('source/adapter pair has no reviewed publication contract')
  }
  const head = await readVerifiedPositionHistoryHead(
    runtime.database,
    input.source.id,
    input.trader.id
  )
  const acquisition = await captureHistoryAcquisition({
    source: input.source,
    traderId: input.trader.id,
    exchangeTraderId: input.trader.exchange_trader_id,
    kind: 'position_history',
    cursor: head.cursor,
    attemptStartedAt: new Date().toISOString(),
    stream: input.adapter.getHistory(
      input.session,
      input.source,
      input.trader.exchange_trader_id,
      'position_history',
      head.cursor,
      input.trader.meta
    ),
    terminalVerifier:
      input.adapter.historyTerminalVerifier?.(input.source, 'position_history') ?? undefined,
  })

  const rawInput = Object.freeze({
    artifact: acquisition.artifact,
    sourceRunId: acquisition.sourceRunId,
  }) satisfies WriteHistoryRawArtifactInput
  const rawObject = await persistHistoryRawArtifactFirst(rawInput, runtime)

  // Upstream/verifier failures remain durable audit evidence and cannot reach
  // preparation or the database authority.
  if (acquisition.error !== null) throw acquisition.error

  // Rebuild only after Storage + RAW pointer durability. This avoids retaining
  // the potentially large canonical row set across the upload boundary.
  const publication = preparePublicationAfterRaw(
    acquisition.artifact,
    acquisition.sourceRunId,
    head.publicationId,
    rawObject,
    input.source
  )
  const receipt = await publishPreparedVerifiedPositionHistory(publication, runtime)
  return Object.freeze({ rawObject, receipt })
}

/** RAW-only helper contract used by Tier-B for non-publishable history kinds. */
export async function captureTierBHistoryRawOnly(
  input: Omit<CaptureAndPublishVerifiedPositionHistoryInput, 'source'> & {
    readonly kind: HistoryKind
    readonly source: SourceRow
  },
  runtime: VerifiedPositionHistoryPublisherRuntime = defaultRuntime()
): Promise<RawObjectReceipt> {
  const acquisition = await captureHistoryAcquisition({
    source: input.source,
    traderId: input.trader.id,
    exchangeTraderId: input.trader.exchange_trader_id,
    kind: input.kind,
    cursor: null,
    attemptStartedAt: new Date().toISOString(),
    stream: input.adapter.getHistory(
      input.session,
      input.source,
      input.trader.exchange_trader_id,
      input.kind,
      null,
      input.trader.meta
    ),
    terminalVerifier:
      input.adapter.historyTerminalVerifier?.(input.source, input.kind) ?? undefined,
  })
  const rawObject = await persistHistoryRawArtifactFirst(
    Object.freeze({
      artifact: acquisition.artifact,
      sourceRunId: acquisition.sourceRunId,
    }),
    runtime
  )
  if (acquisition.error !== null) throw acquisition.error
  return rawObject
}
