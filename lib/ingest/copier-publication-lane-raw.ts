/**
 * Deterministic RAW persistence for publication-lane-bound copier evidence.
 * This is intentionally separate from the generic history writer: only the
 * strict verified/exhausted wrapper can acquire the copier_snapshot role.
 */

import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { IngestQueryExecutor } from './db'
import {
  COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
  COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE,
  parseCopierPublicationLaneArtifact,
  type CopierPublicationLaneArtifact,
} from './copier-publication-lane-artifact'
import { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalJson } from './strict-canonical-json'

export const COPIER_PUBLICATION_LANE_RAW_EVIDENCE_CONTRACT =
  'arena.ingest.copier-publication-lane-raw-evidence@1' as const

const RAW_BUCKET = 'raw-snapshots'
const RAW_UPLOAD_ATTEMPTS = 3
const RAW_UPLOAD_RETRY_BASE_MS = 750
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000

let storageClient: SupabaseClient | null = null

export interface CopierPublicationLaneRawReceipt {
  id: number
  storagePath: string
  contentHash: string
}

export type CopierPublicationLaneTransactionRunner = <T>(
  operation: (transaction: IngestQueryExecutor) => Promise<T>
) => Promise<T>

export interface WriteCopierPublicationLaneRawInput {
  artifact: CopierPublicationLaneArtifact
}

interface NormalizedRawInput {
  artifact: CopierPublicationLaneArtifact
  sourceRunId: string
  acquisitionSourceRunId: string
  observedAt: string
  storagePath: string
  jobType: 'history:copiers' | 'tier_c'
}

interface PreparedRawArtifact {
  input: NormalizedRawInput
  storagePath: string
  jsonBytes: Buffer
  gzipBytes: Buffer
  contentHash: string
  durableCompressedBytes: number
  metaBase: Readonly<Record<string, unknown>>
}

interface RawPointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at_exact: boolean
  observed_at_not_future: boolean
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

interface StorageError {
  message?: string
  status?: number | string
  statusCode?: number | string
}

function rawError(detail: string): Error {
  return new Error(`[ingest] copier publication lane RAW failed: ${detail}`)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw rawError(`${label} must be a positive safe integer`)
  }
}

function storageErrorStatus(error: StorageError): number | null {
  const raw = error.statusCode ?? error.status
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function isAlreadyUploaded(error: StorageError): boolean {
  return storageErrorStatus(error) === 409 || /already exists|duplicate/i.test(error.message ?? '')
}

function isTransientStorageError(error: StorageError): boolean {
  const status = storageErrorStatus(error)
  if (status !== null && [408, 429, 500, 502, 503, 504].includes(status)) return true
  return /timeout|timed out|connection|econnreset|etimedout|fetch failed|bad gateway|service unavailable/i.test(
    error.message ?? ''
  )
}

function getStorageClient(): SupabaseClient {
  if (storageClient) return storageClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw rawError('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  }
  storageClient = createClient(url, key, { auth: { persistSession: false } })
  return storageClient
}

function normalizeRawInput(input: WriteCopierPublicationLaneRawInput): NormalizedRawInput {
  const artifact = parseCopierPublicationLaneArtifact(input.artifact)
  const sourceRunId = createHash('sha256')
    .update(strictCanonicalJson(artifact), 'utf8')
    .digest('hex')
  const observedAt = artifact.acquisition.pages.at(-1)!.fetched_at
  if (Date.parse(observedAt) > Date.now() + MAX_FUTURE_CLOCK_SKEW_MS) {
    throw rawError('observed_at is more than five minutes in the future')
  }
  return {
    artifact,
    sourceRunId,
    acquisitionSourceRunId: artifact.acquisition_source_run_id,
    observedAt,
    storagePath:
      `${artifact.acquisition.source.slug}/copier_publication/${artifact.publication_lane}/` +
      `${sourceRunId}/${COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE}_${sourceRunId}.json.gz`,
    jobType: artifact.publication_lane === 'tier_b' ? 'history:copiers' : 'tier_c',
  }
}

function rawIntegrity(
  compressedBytes: number,
  uncompressedBytes: number
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: 1,
    content_type: 'application/json',
    encoding: 'utf-8',
    compression: 'gzip',
    hash_algorithm: 'sha256',
    hash_scope: 'json_utf8',
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    compressed_bytes: compressedBytes,
    uncompressed_bytes: uncompressedBytes,
  })
}

function rawMetaBase(input: NormalizedRawInput): Readonly<Record<string, unknown>> {
  const { acquisition } = input.artifact
  return Object.freeze({
    surface: 'copiers',
    publication_eligible: true,
    publication_evidence_contract: COPIER_PUBLICATION_LANE_RAW_EVIDENCE_CONTRACT,
    data_contract: COPIER_PUBLICATION_LANE_ARTIFACT_CONTRACT,
    publication_lane: input.artifact.publication_lane,
    source_run_id: input.sourceRunId,
    acquisition_contract: acquisition.contract,
    acquisition_source_run_id: input.acquisitionSourceRunId,
    source_id: acquisition.source.id,
    source_slug: acquisition.source.slug,
    trader_id: acquisition.trader.id,
    exchange_trader_id: acquisition.trader.exchange_trader_id,
    history_kind: acquisition.history_kind,
    attempt_started_at: acquisition.attempt_started_at,
    starting_cursor: acquisition.starting_cursor,
    capture_config: acquisition.capture_config,
    observed_at: input.observedAt,
    page_count: acquisition.pages.length,
    terminal_evidence_state: acquisition.termination.evidence_state,
    scan_terminal_state: acquisition.termination.scan_terminal_state,
    verifier_contract: acquisition.termination.verifier_contract,
    termination: acquisition.termination,
  })
}

function prepareRawArtifact(input: NormalizedRawInput): PreparedRawArtifact {
  const jsonBytes = Buffer.from(strictCanonicalJson(input.artifact), 'utf8')
  const gzipBytes = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== input.sourceRunId) {
    throw rawError('serialized wrapper digest does not match source run id')
  }
  return {
    input,
    storagePath: input.storagePath,
    jsonBytes,
    gzipBytes,
    contentHash,
    durableCompressedBytes: gzipBytes.byteLength,
    metaBase: rawMetaBase(input),
  }
}

function rawMeta(prepared: PreparedRawArtifact): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...prepared.metaBase,
    raw_integrity: rawIntegrity(prepared.durableCompressedBytes, prepared.jsonBytes.byteLength),
  })
}

async function verifyExistingStorageObject(prepared: PreparedRawArtifact): Promise<number> {
  const { data, error } = await getStorageClient()
    .storage.from(RAW_BUCKET)
    .download(prepared.storagePath)
  if (error || !data) {
    throw rawError(
      `cannot verify existing Storage object ${prepared.storagePath}: ${error?.message ?? 'empty body'}`
    )
  }

  let gzipBytes: Buffer
  try {
    gzipBytes = Buffer.from(await data.arrayBuffer())
  } catch (cause) {
    throw rawError(
      `cannot read existing Storage object ${prepared.storagePath}: ${asError(cause).message}`
    )
  }
  if (
    gzipBytes.byteLength < 3 ||
    gzipBytes[0] !== 0x1f ||
    gzipBytes[1] !== 0x8b ||
    gzipBytes[2] !== 0x08
  ) {
    throw rawError(`existing Storage object ${prepared.storagePath} is not gzip`)
  }

  let jsonBytes: Buffer
  try {
    jsonBytes = gunzipSync(gzipBytes)
  } catch {
    throw rawError(`existing Storage object ${prepared.storagePath} has invalid gzip data`)
  }
  if (!jsonBytes.equals(prepared.jsonBytes)) {
    throw rawError(`existing Storage object ${prepared.storagePath} has different content`)
  }
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== prepared.contentHash) {
    throw rawError(`existing Storage object ${prepared.storagePath} has a digest mismatch`)
  }
  return gzipBytes.byteLength
}

async function uploadDeterministicRaw(prepared: PreparedRawArtifact): Promise<number> {
  const bucket = getStorageClient().storage.from(RAW_BUCKET)
  for (let attempt = 1; attempt <= RAW_UPLOAD_ATTEMPTS; attempt += 1) {
    const { error } = await bucket.upload(prepared.storagePath, prepared.gzipBytes, {
      contentType: 'application/gzip',
      upsert: false,
    })
    if (!error) return prepared.gzipBytes.byteLength
    if (isAlreadyUploaded(error)) return verifyExistingStorageObject(prepared)
    if (attempt === RAW_UPLOAD_ATTEMPTS || !isTransientStorageError(error)) {
      throw rawError(`Storage upload failed (${prepared.storagePath}): ${error.message}`)
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RAW_UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1))
    )
  }
  throw rawError(`Storage upload attempts exhausted (${prepared.storagePath})`)
}

async function loadRawPointers(
  transaction: IngestQueryExecutor,
  prepared: PreparedRawArtifact
): Promise<RawPointerRow[]> {
  const { rows } = await transaction.query<RawPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at = $3::timestamptz AS fetched_at_exact,
            fetched_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
              AS observed_at_not_future,
            storage_path, bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role
       FROM arena.raw_objects
      WHERE storage_path = $1
         OR (
           source_run_id = $2
           AND trust_artifact_role = 'copier_snapshot'
         )
      ORDER BY id
      FOR UPDATE`,
    [prepared.storagePath, prepared.input.sourceRunId, prepared.input.observedAt]
  )
  return rows
}

async function insertRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedRawArtifact
): Promise<void> {
  const { acquisition } = prepared.input.artifact
  await transaction.query(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
        bytes, content_hash, meta, source_run_id, trust_artifact_role)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (storage_path) DO NOTHING`,
    [
      acquisition.source.id,
      prepared.input.jobType,
      acquisition.trader.id,
      prepared.input.observedAt,
      prepared.storagePath,
      prepared.durableCompressedBytes,
      prepared.contentHash,
      strictCanonicalJson(rawMeta(prepared)),
      prepared.input.sourceRunId,
      COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE,
    ]
  )
}

function validateRawPointer(
  rows: readonly RawPointerRow[],
  prepared: PreparedRawArtifact
): CopierPublicationLaneRawReceipt {
  if (rows.length !== 1) {
    throw rawError(`expected one exact database pointer, found ${rows.length}`)
  }
  const row = rows[0]
  const { acquisition } = prepared.input.artifact
  assertSafePositiveInteger(row.id, 'RAW pointer id')
  let metaMatches = false
  try {
    metaMatches = strictCanonicalJson(row.meta) === strictCanonicalJson(rawMeta(prepared))
  } catch {
    metaMatches = false
  }
  if (
    row.source_id !== acquisition.source.id ||
    row.job_type !== prepared.input.jobType ||
    row.trader_id !== acquisition.trader.id ||
    row.timeframe !== null ||
    row.fetched_at_exact !== true ||
    row.observed_at_not_future !== true ||
    row.storage_path !== prepared.storagePath ||
    row.bytes !== prepared.durableCompressedBytes ||
    row.content_hash !== prepared.input.sourceRunId ||
    row.quarantined !== false ||
    row.source_run_id !== prepared.input.sourceRunId ||
    row.trust_artifact_role !== COPIER_PUBLICATION_LANE_RAW_ARTIFACT_ROLE ||
    !metaMatches
  ) {
    throw rawError(`database pointer ${row.id} does not match the exact wrapper`)
  }
  return {
    id: row.id,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
  }
}

async function persistRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedRawArtifact
): Promise<CopierPublicationLaneRawReceipt> {
  await transaction.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`arena.copier-publication-lane-raw:${prepared.input.sourceRunId}`]
  )
  let rows = await loadRawPointers(transaction, prepared)
  if (rows.length === 0) {
    await insertRawPointer(transaction, prepared)
    rows = await loadRawPointers(transaction, prepared)
  }
  return validateRawPointer(rows, prepared)
}

/**
 * Store the whole lane wrapper before publishing its exact immutable pointer.
 * Replays verify both existing Storage bytes and every pointer coordinate.
 */
export async function writeCopierPublicationLaneRawArtifact(
  input: WriteCopierPublicationLaneRawInput,
  runTransaction: CopierPublicationLaneTransactionRunner
): Promise<CopierPublicationLaneRawReceipt> {
  if (typeof runTransaction !== 'function') {
    throw rawError('a claimed transaction runner is required')
  }
  const normalized = normalizeRawInput(input)
  const prepared = prepareRawArtifact(normalized)
  prepared.durableCompressedBytes = await uploadDeterministicRaw(prepared)
  return runTransaction((transaction) => persistRawPointer(transaction, prepared))
}
