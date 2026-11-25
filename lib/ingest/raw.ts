/**
 * RAW layer writer (spec §2.1 RAW, §13.3): immutable source payloads go to
 * Supabase Storage as gzipped JSON, with only a pointer row in Postgres
 * (arena.raw_objects). Every serving-layer bug becomes a re-parse, not a
 * re-scrape. Retention: 30 days unless quarantined (worker maintenance job).
 *
 * WORKER-ONLY MODULE (service-role Storage client + direct PG).
 */

import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { isProxy } from 'node:util/types'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PoolClient } from 'pg'
import { getIngestPool, ingestClientConnect, type IngestQueryExecutor } from './db'
import type { RankingTimeframe, RawPage } from './core/types'
import {
  LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT,
  LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT,
  parseLeaderboardAcquisitionManifestV3,
  parseLeaderboardAcquisitionManifestV4,
  projectPartitionedNumericParserPage,
  type BuiltLeaderboardAcquisitionManifestV3,
  type BuiltLeaderboardAcquisitionManifestV4,
  type LeaderboardAcquisitionManifestV3,
  type LeaderboardAcquisitionManifestV4,
} from './acquisition-manifest'
import {
  projectLeaderboardManifestV3Outcome,
  projectLeaderboardManifestV4Outcome,
  type LeaderboardAcquisitionAttempt,
  type LeaderboardManifestOutcomeProjection,
} from './acquisition-attempts'
import {
  HISTORY_ACQUISITION_ARTIFACT_CONTRACT,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from './history-acquisition'
import {
  POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
  revalidatePositionHistoryAcquisitionArtifactV2,
  type PositionHistoryAcquisitionArtifactV2,
} from './position-history-acquisition-v2'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalJsonDigestWithinLimit,
  strictCanonicalSha256,
} from './strict-canonical-json'
import {
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
  copierSnapshotSourceRunId,
  copierSnapshotStoragePath,
  COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE,
  revalidateCopierSnapshotArtifact,
  type CopierSnapshotArtifact,
} from './copier-snapshot-artifact'
import {
  COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
  revalidateCopierSnapshotArtifactV2,
  type CopierSnapshotArtifactV2,
} from './copier-snapshot-artifact-v2'
import {
  COPIER_CANDIDATE_LEDGER_CONTRACT,
  COPIER_PARSER_CONSERVATION_CONTRACT,
} from './copier-candidate-conservation'
import { COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT } from './copier-snapshot-projection-ledger'

export const RAW_BUCKET = 'raw-snapshots'

let storageClient: SupabaseClient | null = null

const RAW_UPLOAD_ATTEMPTS = 3
const RAW_UPLOAD_RETRY_BASE_MS = 750
const RAW_GC_ADVISORY_LOCK = "pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)"
const RAW_POINTER_MAX_COMPRESSED_BYTES = 2_147_483_647
const POSITION_HISTORY_RAW_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const COPIER_SNAPSHOT_TRUST_RAW_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

export const RAW_JSON_STRINGIFY_CONTRACT = 'arena.raw-json-stringify@1' as const
export const POSITION_HISTORY_RAW_JOB_TYPE = 'history:position_history' as const
export const EVENT_HISTORY_RAW_ARTIFACT_ROLE = 'event_history' as const
export const COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE = 'copier_snapshot_trust' as const
export const POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT =
  'arena.position-history-publication-evidence@1' as const
export type RawSerializationContract =
  | typeof RAW_JSON_STRINGIFY_CONTRACT
  | typeof STRICT_CANONICAL_JSON_CONTRACT

interface StorageUploadError {
  message?: string
  status?: number | string
  statusCode?: number | string
}

function storageErrorStatus(error: StorageUploadError): number | null {
  const raw = error.statusCode ?? error.status
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function isTransientStorageError(error: StorageUploadError): boolean {
  const status = storageErrorStatus(error)
  if (status !== null && [408, 429, 500, 502, 503, 504].includes(status)) return true

  return /timeout|timed out|connection|econnreset|etimedout|fetch failed|bad gateway|service unavailable/i.test(
    error.message ?? ''
  )
}

function isAlreadyUploaded(error: StorageUploadError): boolean {
  return storageErrorStatus(error) === 409 || /already exists|duplicate/i.test(error.message ?? '')
}

async function uploadRawPayload(storagePath: string, gz: Buffer): Promise<void> {
  const bucket = getStorageClient().storage.from(RAW_BUCKET)

  for (let attempt = 1; attempt <= RAW_UPLOAD_ATTEMPTS; attempt += 1) {
    const { error } = await bucket.upload(storagePath, gz, {
      contentType: 'application/gzip',
      upsert: false,
    })
    if (!error) return

    // A previous timed-out request may have committed before its response was
    // lost. The content-addressed path and identical payload make 409 on a
    // retry equivalent to success without weakening RAW immutability.
    if (attempt > 1 && isAlreadyUploaded(error)) return

    if (attempt === RAW_UPLOAD_ATTEMPTS || !isTransientStorageError(error)) {
      throw new Error(`[ingest] RAW upload failed (${storagePath}): ${error.message}`)
    }

    const delayMs = RAW_UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)
    console.warn(
      `[ingest] RAW upload transient failure (${attempt}/${RAW_UPLOAD_ATTEMPTS}); retrying in ${delayMs}ms: ${error.message}`
    )
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

function getStorageClient(): SupabaseClient {
  if (storageClient) return storageClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('[ingest] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  }
  storageClient = createClient(url, key, { auth: { persistSession: false } })
  return storageClient
}

export type TierARawJobType = 'tier_a' | 'tier_a_manifest' | 'tier_a_failure'
export type NonTierARawJobType =
  | 'tier_b'
  | 'tier_b_series'
  | 'tier_c'
  | 'tier_d'
  | 'bots'
  | `history:${string}`
export type RawJobType = TierARawJobType | NonTierARawJobType

export interface WriteRawInput<JobType extends RawJobType = RawJobType> {
  sourceId: number
  sourceSlug: string
  jobType: JobType
  traderId?: number | null
  timeframe?: number | null
  payload: unknown
  meta?: Record<string, unknown>
  serialization?: RawSerializationContract
}

export interface RawObjectReceipt {
  id: number
  storagePath: string
  contentHash: string
}

/**
 * Caller-owned short transaction boundary for publishing Postgres pointers
 * after their immutable Storage objects are durable. The RAW module invokes a
 * supplied runner exactly once and never performs transaction control or
 * connection fallback inside its callback.
 */
export type IngestTransactionRunner = <T>(
  operation: (transaction: IngestQueryExecutor) => Promise<T>
) => Promise<T>

const TIER_A_RAW_JOB_TYPES: ReadonlySet<string> = new Set<TierARawJobType>([
  'tier_a',
  'tier_a_manifest',
  'tier_a_failure',
])

function assertTierARawTransactionRunner(
  runTransaction: IngestTransactionRunner | undefined
): asserts runTransaction is IngestTransactionRunner {
  if (typeof runTransaction !== 'function') {
    throw artifactSetError('Tier-A RAW persistence requires a claimed transaction runner')
  }
}

export interface LeaderboardRawArtifactSetReceipt {
  sourcePayload: RawObjectReceipt
  populationManifest: RawObjectReceipt
}

interface WriteAttemptBoundLeaderboardRawArtifactSetInputBase {
  attempt: LeaderboardAcquisitionAttempt
  sourcePages: RawPage[]
}

export interface WriteAttemptBoundLeaderboardRawArtifactSetV3Input extends WriteAttemptBoundLeaderboardRawArtifactSetInputBase {
  built: BuiltLeaderboardAcquisitionManifestV3
}

export interface WriteAttemptBoundLeaderboardRawArtifactSetV4Input extends WriteAttemptBoundLeaderboardRawArtifactSetInputBase {
  built: BuiltLeaderboardAcquisitionManifestV4
}

export type WriteAttemptBoundLeaderboardRawArtifactSetInput =
  | WriteAttemptBoundLeaderboardRawArtifactSetV3Input
  | WriteAttemptBoundLeaderboardRawArtifactSetV4Input

export interface AttemptBoundLeaderboardRawArtifactSetReceipt extends LeaderboardRawArtifactSetReceipt {
  projection: LeaderboardManifestOutcomeProjection
}

type LeaderboardAcquisitionManifestLike =
  | LeaderboardAcquisitionManifestV3
  | LeaderboardAcquisitionManifestV4

interface NormalizedLeaderboardRawArtifactSetInput {
  sourceId: number
  sourceSlug: string
  timeframe: RankingTimeframe
  sourceRunId: string
  sourcePages: RawPage[]
  manifest: LeaderboardAcquisitionManifestLike
  observationCycleId: string | null
}

interface RawObjectPointer {
  storage_path: string
  bytes: number
  content_hash: string
  meta: unknown
}

interface RawObjectGcPointer {
  storage_path: string
}

type LeaderboardTrustArtifactRole = 'source_payload' | 'population_manifest'

interface PreparedDeterministicRawArtifact {
  storagePath: string
  jsonBytes: Buffer
  gzipBytes: Buffer
  contentHash: string
  durableCompressedBytes: number
}

interface PreparedLeaderboardTrustArtifact extends PreparedDeterministicRawArtifact {
  role: LeaderboardTrustArtifactRole
  jobType: 'tier_a' | 'tier_a_manifest'
  metaBase: Record<string, unknown>
}

interface LeaderboardTrustPointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at: string
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rawIntegrityError(rawObjectId: number, storagePath: string, detail: string): Error {
  return new Error(
    `[ingest] RAW integrity failed (id=${rawObjectId}, path=${JSON.stringify(storagePath)}): ${detail}`
  )
}

function verifyRawIntegrityMetadata(
  rawObjectId: number,
  storagePath: string,
  meta: unknown,
  compressedBytes: number,
  uncompressedBytes: number
): RawSerializationContract | null {
  if (!isRecord(meta) || !Object.hasOwn(meta, 'raw_integrity')) return null

  const integrity = meta.raw_integrity
  if (!isRecord(integrity)) {
    throw rawIntegrityError(rawObjectId, storagePath, 'raw_integrity metadata is malformed')
  }

  const requiredValues: Record<string, string | number> = {
    version: 1,
    content_type: 'application/json',
    encoding: 'utf-8',
    compression: 'gzip',
    hash_algorithm: 'sha256',
    hash_scope: 'json_utf8',
    compressed_bytes: compressedBytes,
    uncompressed_bytes: uncompressedBytes,
  }

  for (const [field, expected] of Object.entries(requiredValues)) {
    if (integrity[field] !== expected) {
      throw rawIntegrityError(rawObjectId, storagePath, `raw_integrity.${field} mismatch`)
    }
  }

  const serializationContract = integrity.serialization_contract
  if (serializationContract === undefined) return null
  if (
    serializationContract !== RAW_JSON_STRINGIFY_CONTRACT &&
    serializationContract !== STRICT_CANONICAL_JSON_CONTRACT
  ) {
    throw rawIntegrityError(
      rawObjectId,
      storagePath,
      'raw_integrity.serialization_contract mismatch'
    )
  }
  return serializationContract
}

function serializeRawPayload(
  payload: unknown,
  serialization: RawSerializationContract | undefined
): { json: string; serializationContract: RawSerializationContract } {
  const serializationContract =
    serialization === undefined ? RAW_JSON_STRINGIFY_CONTRACT : serialization
  if (serializationContract === RAW_JSON_STRINGIFY_CONTRACT) {
    const json = JSON.stringify(payload)
    if (json === undefined) {
      throw new TypeError('[ingest] RAW JSON payload is not serializable')
    }
    return { json, serializationContract }
  }
  if (serializationContract === STRICT_CANONICAL_JSON_CONTRACT) {
    return { json: strictCanonicalJson(payload), serializationContract }
  }
  throw new TypeError(`[ingest] unsupported RAW serialization contract: ${serializationContract}`)
}

function rawIntegrityMeta(
  metaBase: Record<string, unknown>,
  serializationContract: RawSerializationContract,
  compressedBytes: number,
  uncompressedBytes: number
): Record<string, unknown> {
  return {
    ...metaBase,
    raw_integrity: {
      version: 1,
      content_type: 'application/json',
      encoding: 'utf-8',
      compression: 'gzip',
      hash_algorithm: 'sha256',
      hash_scope: 'json_utf8',
      serialization_contract: serializationContract,
      compressed_bytes: compressedBytes,
      uncompressed_bytes: uncompressedBytes,
    },
  }
}

function artifactSetError(detail: string): Error {
  return new Error(`[ingest] leaderboard RAW artifact set failed: ${detail}`)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function assertSafePositiveInteger(
  value: number,
  label: string,
  createError: (detail: string) => Error = artifactSetError
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw createError(`${label} must be a positive safe integer`)
  }
}

function validateLeaderboardRawArtifactSetCoordinates(
  input: Pick<
    NormalizedLeaderboardRawArtifactSetInput,
    'sourceId' | 'sourceSlug' | 'timeframe' | 'sourceRunId' | 'observationCycleId'
  >
): void {
  assertSafePositiveInteger(input.sourceId, 'source id')
  if (![7, 30, 90].includes(input.timeframe)) {
    throw artifactSetError('timeframe must be 7, 30, or 90')
  }
  if (!/^[a-z0-9_]+$/.test(input.sourceSlug)) {
    throw artifactSetError('source slug must be one lower-snake-case path segment')
  }
  if (!/^[0-9a-f]{64}$/.test(input.sourceRunId)) {
    throw artifactSetError('source run id must be a lowercase SHA-256 digest')
  }
  if (
    input.observationCycleId !== null &&
    (input.observationCycleId.trim() !== input.observationCycleId ||
      input.observationCycleId.length === 0)
  ) {
    throw artifactSetError('observation cycle id must be canonical or null')
  }
}

function validateLeaderboardManifestPages(
  input: Pick<NormalizedLeaderboardRawArtifactSetInput, 'sourcePages'>,
  manifest: LeaderboardAcquisitionManifestLike
): void {
  if (manifest.source_pages.length !== input.sourcePages.length) {
    throw artifactSetError('source payload page count does not match the manifest')
  }
  for (const [index, page] of input.sourcePages.entries()) {
    const evidence = manifest.source_pages[index]
    const canonicalPage = {
      pageIndex: evidence.stored_page_index,
      payload: page.payload,
      url: evidence.url,
      fetchedAt: evidence.fetched_at,
    }
    if (
      page.pageIndex !== evidence.stored_page_index ||
      page.url !== evidence.url ||
      page.fetchedAt !== evidence.fetched_at ||
      strictCanonicalSha256(page.payload) !== evidence.payload.sha256 ||
      strictCanonicalJson(page) !== strictCanonicalJson(canonicalPage)
    ) {
      throw artifactSetError(`source payload page ${index + 1} does not match the manifest`)
    }
  }
  const transformation = manifest.parser_input.transformation
  if (transformation.kind === 'dedupe_rechunk') {
    throw artifactSetError(
      'dedupe/rechunk parser evidence requires a separately persisted parser payload'
    )
  }
  const reconstructedParserPages =
    transformation.kind === 'identity_projection'
      ? transformation.source_page_ordinals.map((ordinal) => input.sourcePages[ordinal - 1])
      : transformation.page_bindings.map((binding, index) => {
          if (binding.source_page_ordinal !== transformation.source_page_ordinals[index]) {
            throw artifactSetError(
              `parser input page ${index + 1} does not match its source-page ordinal binding`
            )
          }
          const sourcePage = input.sourcePages[binding.source_page_ordinal - 1]
          return sourcePage === undefined
            ? undefined
            : projectPartitionedNumericParserPage(sourcePage, binding)
        })
  if (
    reconstructedParserPages.some((page) => page === undefined) ||
    manifest.parser_input.page_count !== reconstructedParserPages.length ||
    strictCanonicalSha256(reconstructedParserPages) !== manifest.parser_input.sha256
  ) {
    throw artifactSetError('parser input digest does not match the persisted source pages')
  }
}

function prepareLeaderboardTrustArtifact(
  input: NormalizedLeaderboardRawArtifactSetInput,
  role: LeaderboardTrustArtifactRole,
  payload: unknown,
  metaBase: Record<string, unknown>
): PreparedLeaderboardTrustArtifact {
  const { json } = serializeRawPayload(payload, STRICT_CANONICAL_JSON_CONTRACT)
  const jsonBytes = Buffer.from(json, 'utf8')
  const gzipBytes = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  const jobType = role === 'source_payload' ? 'tier_a' : 'tier_a_manifest'
  const storagePath =
    `${input.sourceSlug}/tier_a_trust/${input.sourceRunId}/` + `${role}_${contentHash}.json.gz`
  return {
    role,
    jobType,
    storagePath,
    jsonBytes,
    gzipBytes,
    contentHash,
    metaBase,
    durableCompressedBytes: gzipBytes.byteLength,
  }
}

async function verifyExistingDeterministicRaw(
  artifact: PreparedDeterministicRawArtifact,
  createError: (detail: string) => Error = artifactSetError
): Promise<number> {
  const { data, error } = await getStorageClient()
    .storage.from(RAW_BUCKET)
    .download(artifact.storagePath)
  if (error || !data) {
    throw createError(
      `cannot verify existing Storage object ${artifact.storagePath}: ${error?.message ?? 'empty body'}`
    )
  }

  const maxCompressedBytes = deterministicRawMaxCompressedBytes(artifact)
  const declaredCompressedBytes: unknown = data.size
  if (
    declaredCompressedBytes !== undefined &&
    (typeof declaredCompressedBytes !== 'number' ||
      !Number.isSafeInteger(declaredCompressedBytes) ||
      declaredCompressedBytes < 0 ||
      declaredCompressedBytes > maxCompressedBytes)
  ) {
    throw createError(
      `existing Storage object ${artifact.storagePath} exceeds its compressed byte limit`
    )
  }

  let gzipBytes: Buffer
  try {
    gzipBytes = Buffer.from(await data.arrayBuffer())
  } catch (cause) {
    throw createError(
      `cannot read existing Storage object ${artifact.storagePath}: ${asError(cause).message}`
    )
  }
  if (gzipBytes.byteLength > maxCompressedBytes) {
    throw createError(
      `existing Storage object ${artifact.storagePath} exceeds its compressed byte limit`
    )
  }
  if (
    gzipBytes.byteLength < 3 ||
    gzipBytes[0] !== 0x1f ||
    gzipBytes[1] !== 0x8b ||
    gzipBytes[2] !== 0x08
  ) {
    throw createError(`existing Storage object ${artifact.storagePath} is not gzip`)
  }

  let jsonBytes: Buffer
  try {
    jsonBytes = gunzipSync(gzipBytes, {
      maxOutputLength: artifact.jsonBytes.byteLength,
    })
  } catch {
    throw createError(`existing Storage object ${artifact.storagePath} has invalid gzip data`)
  }
  if (!jsonBytes.equals(artifact.jsonBytes)) {
    throw createError(`existing Storage object ${artifact.storagePath} has different content`)
  }
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== artifact.contentHash) {
    throw createError(`existing Storage object ${artifact.storagePath} has a digest mismatch`)
  }
  let parsed: unknown
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
    parsed = JSON.parse(json)
  } catch {
    throw createError(`existing Storage object ${artifact.storagePath} is not canonical JSON`)
  }
  if (strictCanonicalJson(parsed) !== artifact.jsonBytes.toString('utf8')) {
    throw createError(`existing Storage object ${artifact.storagePath} is not canonical JSON`)
  }
  return gzipBytes.byteLength
}

function deterministicRawMaxCompressedBytesForUncompressedBytes(uncompressedBytes: number): number {
  const boundedOverhead = Math.max(64 * 1024, Math.ceil(uncompressedBytes / 16_384) * 16)
  return Math.min(RAW_POINTER_MAX_COMPRESSED_BYTES, uncompressedBytes + boundedOverhead)
}

function deterministicRawMaxCompressedBytes(
  artifact: Pick<PreparedDeterministicRawArtifact, 'jsonBytes'>
): number {
  return deterministicRawMaxCompressedBytesForUncompressedBytes(artifact.jsonBytes.byteLength)
}

async function uploadDeterministicRaw(
  artifact: PreparedDeterministicRawArtifact,
  createError: (detail: string) => Error = artifactSetError
): Promise<number> {
  if (artifact.gzipBytes.byteLength > deterministicRawMaxCompressedBytes(artifact)) {
    throw createError(`Storage upload exceeds compressed byte limit (${artifact.storagePath})`)
  }
  const bucket = getStorageClient().storage.from(RAW_BUCKET)
  for (let attempt = 1; attempt <= RAW_UPLOAD_ATTEMPTS; attempt += 1) {
    const { error } = await bucket.upload(artifact.storagePath, artifact.gzipBytes, {
      contentType: 'application/gzip',
      upsert: false,
    })
    if (!error) return artifact.gzipBytes.byteLength
    if (isAlreadyUploaded(error)) return verifyExistingDeterministicRaw(artifact, createError)
    if (attempt === RAW_UPLOAD_ATTEMPTS || !isTransientStorageError(error)) {
      throw createError(`Storage upload failed (${artifact.storagePath}): ${error.message}`)
    }
    const delayMs = RAW_UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw createError(`Storage upload attempts exhausted (${artifact.storagePath})`)
}

function artifactMeta(artifact: PreparedLeaderboardTrustArtifact): Record<string, unknown> {
  return rawIntegrityMeta(
    artifact.metaBase,
    STRICT_CANONICAL_JSON_CONTRACT,
    artifact.durableCompressedBytes,
    artifact.jsonBytes.byteLength
  )
}

function trustPointerSelectSql(forUpdate: boolean): string {
  return `SELECT id, source_id, job_type, trader_id, timeframe,
                 fetched_at::text AS fetched_at, storage_path,
                 bytes, content_hash, quarantined, meta,
                 source_run_id, trust_artifact_role
            FROM arena.raw_objects
           WHERE storage_path = ANY($1::text[])
              OR (
                source_run_id = $2
                AND (
                  trust_artifact_role = 'population_manifest'
                  OR (
                    trust_artifact_role = 'source_payload'
                    AND job_type = 'tier_a'
                    AND trader_id IS NULL
                  )
                )
              )
           ORDER BY id${forUpdate ? '\n           FOR UPDATE' : ''}`
}

async function loadLeaderboardTrustPointers(
  client: IngestQueryExecutor,
  artifacts: readonly PreparedLeaderboardTrustArtifact[],
  sourceRunId: string,
  forUpdate: boolean
): Promise<LeaderboardTrustPointerRow[]> {
  const { rows } = await client.query<LeaderboardTrustPointerRow>(
    trustPointerSelectSql(forUpdate),
    [artifacts.map((artifact) => artifact.storagePath), sourceRunId]
  )
  return rows
}

function validateLeaderboardTrustPointers(
  rows: readonly LeaderboardTrustPointerRow[],
  artifacts: readonly PreparedLeaderboardTrustArtifact[],
  input: NormalizedLeaderboardRawArtifactSetInput,
  allowUnbound: boolean
): { state: 'bound' | 'unbound'; receipts: LeaderboardRawArtifactSetReceipt } {
  if (rows.length !== artifacts.length) {
    throw artifactSetError(
      `expected ${artifacts.length} database pointers for ${input.sourceRunId}, found ${rows.length}`
    )
  }
  const expectedByPath = new Map(artifacts.map((artifact) => [artifact.storagePath, artifact]))
  const ids = new Set<number>()
  let bound = 0
  let unbound = 0
  const receipts = new Map<LeaderboardTrustArtifactRole, RawObjectReceipt>()

  for (const row of rows) {
    const artifact = expectedByPath.get(row.storage_path)
    if (!artifact) {
      throw artifactSetError(`database contains a competing pointer for ${input.sourceRunId}`)
    }
    assertSafePositiveInteger(row.id, 'RAW pointer id')
    if (ids.has(row.id)) throw artifactSetError('database returned duplicate RAW pointer ids')
    ids.add(row.id)

    const expectedMeta = artifactMeta(artifact)
    let metaMatches = false
    try {
      metaMatches = strictCanonicalJson(row.meta) === strictCanonicalJson(expectedMeta)
    } catch {
      metaMatches = false
    }
    if (
      row.source_id !== input.sourceId ||
      row.job_type !== artifact.jobType ||
      row.trader_id !== null ||
      row.timeframe !== input.timeframe ||
      Date.parse(row.fetched_at) !== Date.parse(input.manifest.completed_at) ||
      row.bytes !== artifact.durableCompressedBytes ||
      row.content_hash !== artifact.contentHash ||
      row.quarantined !== false ||
      !metaMatches
    ) {
      throw artifactSetError(`database pointer ${row.id} does not match ${artifact.role}`)
    }

    if (row.source_run_id === null && row.trust_artifact_role === null) {
      unbound += 1
    } else if (
      row.source_run_id === input.sourceRunId &&
      row.trust_artifact_role === artifact.role
    ) {
      bound += 1
    } else {
      throw artifactSetError(`database pointer ${row.id} has a foreign trust binding`)
    }
    receipts.set(artifact.role, {
      id: row.id,
      storagePath: row.storage_path,
      contentHash: row.content_hash,
    })
  }

  if (bound === artifacts.length) {
    return {
      state: 'bound',
      receipts: {
        sourcePayload: receipts.get('source_payload')!,
        populationManifest: receipts.get('population_manifest')!,
      },
    }
  }
  if (allowUnbound && unbound === artifacts.length) {
    return {
      state: 'unbound',
      receipts: {
        sourcePayload: receipts.get('source_payload')!,
        populationManifest: receipts.get('population_manifest')!,
      },
    }
  }
  throw artifactSetError('database pointers are only partially bound')
}

async function insertLeaderboardTrustPointer(
  client: IngestQueryExecutor,
  input: NormalizedLeaderboardRawArtifactSetInput,
  artifact: PreparedLeaderboardTrustArtifact
): Promise<void> {
  const conflictClause =
    artifact.role === 'population_manifest'
      ? `ON CONFLICT (source_run_id)
           WHERE source_run_id IS NOT NULL
             AND trust_artifact_role = 'population_manifest'
         DO NOTHING`
      : `ON CONFLICT (source_run_id)
           WHERE source_run_id IS NOT NULL
             AND trust_artifact_role = 'source_payload'
             AND job_type = 'tier_a'
             AND trader_id IS NULL
         DO NOTHING`
  await client.query(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
        bytes, content_hash, meta, source_run_id, trust_artifact_role)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10)
     ${conflictClause}`,
    [
      input.sourceId,
      artifact.jobType,
      input.timeframe,
      input.manifest.completed_at,
      artifact.storagePath,
      artifact.durableCompressedBytes,
      artifact.contentHash,
      JSON.stringify(artifactMeta(artifact)),
      input.sourceRunId,
      artifact.role,
    ]
  )
}

async function bindUnboundLeaderboardTrustPointers(
  client: IngestQueryExecutor,
  input: NormalizedLeaderboardRawArtifactSetInput,
  artifacts: readonly PreparedLeaderboardTrustArtifact[],
  receipts: LeaderboardRawArtifactSetReceipt
): Promise<void> {
  const { rows } = await client.query<{ id: number }>(
    `UPDATE arena.raw_objects
        SET source_run_id = $1,
            trust_artifact_role = CASE storage_path
              WHEN $2 THEN 'source_payload'
              WHEN $3 THEN 'population_manifest'
            END
      WHERE id = ANY($4::bigint[])
        AND source_run_id IS NULL
        AND trust_artifact_role IS NULL
      RETURNING id`,
    [
      input.sourceRunId,
      artifacts.find((artifact) => artifact.role === 'source_payload')!.storagePath,
      artifacts.find((artifact) => artifact.role === 'population_manifest')!.storagePath,
      [receipts.sourcePayload.id, receipts.populationManifest.id],
    ]
  )
  if (rows.length !== artifacts.length) {
    throw artifactSetError('failed to bind both pre-existing RAW pointers')
  }
}

async function persistLeaderboardTrustPointersInTransaction(
  transaction: IngestQueryExecutor,
  input: NormalizedLeaderboardRawArtifactSetInput,
  artifacts: readonly PreparedLeaderboardTrustArtifact[]
): Promise<LeaderboardRawArtifactSetReceipt> {
  await transaction.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`arena.leaderboard-raw-artifact-set:${input.sourceRunId}`]
  )

  const existing = await loadLeaderboardTrustPointers(
    transaction,
    artifacts,
    input.sourceRunId,
    true
  )
  if (existing.length === 0) {
    for (const artifact of artifacts) {
      await insertLeaderboardTrustPointer(transaction, input, artifact)
    }
  } else if (existing.length !== artifacts.length) {
    throw artifactSetError('database contains only part of the expected RAW pointer pair')
  }

  let verified = validateLeaderboardTrustPointers(
    existing.length === 0
      ? await loadLeaderboardTrustPointers(transaction, artifacts, input.sourceRunId, true)
      : existing,
    artifacts,
    input,
    true
  )
  if (verified.state === 'unbound') {
    await bindUnboundLeaderboardTrustPointers(transaction, input, artifacts, verified.receipts)
    verified = validateLeaderboardTrustPointers(
      await loadLeaderboardTrustPointers(transaction, artifacts, input.sourceRunId, true),
      artifacts,
      input,
      false
    )
  }
  return verified.receipts
}

interface PreparedAttemptBoundLeaderboardManifest {
  manifest: LeaderboardAcquisitionManifestV3 | LeaderboardAcquisitionManifestV4
  projection: LeaderboardManifestOutcomeProjection
}

function prepareAttemptBoundLeaderboardManifest(
  input: WriteAttemptBoundLeaderboardRawArtifactSetInput,
  attempt: LeaderboardAcquisitionAttempt
): PreparedAttemptBoundLeaderboardManifest {
  const built = input.built
  switch (built.manifest.data_contract) {
    case LEADERBOARD_ACQUISITION_MANIFEST_V3_CONTRACT: {
      const manifest = parseLeaderboardAcquisitionManifestV3(built.manifest)
      const normalizedBuilt: BuiltLeaderboardAcquisitionManifestV3 = Object.freeze({
        manifest,
        canonicalJson: built.canonicalJson,
        sourceRunId: built.sourceRunId,
      })
      return {
        manifest,
        projection: projectLeaderboardManifestV3Outcome(attempt, normalizedBuilt),
      }
    }
    case LEADERBOARD_ACQUISITION_MANIFEST_V4_CONTRACT: {
      const manifest = parseLeaderboardAcquisitionManifestV4(built.manifest)
      const normalizedBuilt: BuiltLeaderboardAcquisitionManifestV4 = Object.freeze({
        manifest,
        canonicalJson: built.canonicalJson,
        sourceRunId: built.sourceRunId,
      })
      return {
        manifest,
        projection: projectLeaderboardManifestV4Outcome(attempt, normalizedBuilt),
      }
    }
  }
}

/**
 * Persist an attempt-bound v3 or v4 capture. The returned projection is the
 * exact validated terminal projection that the worker must pass to the
 * acquisition ledger after both RAW pointers are durable.
 */
export async function writeAttemptBoundLeaderboardRawArtifactSet(
  input: WriteAttemptBoundLeaderboardRawArtifactSetInput,
  runTransaction: IngestTransactionRunner
): Promise<AttemptBoundLeaderboardRawArtifactSetReceipt> {
  assertTierARawTransactionRunner(runTransaction)
  // Snapshot all caller-owned identity and evidence before the first await.
  const attempt: LeaderboardAcquisitionAttempt = Object.freeze({ ...input.attempt })
  const { manifest, projection } = prepareAttemptBoundLeaderboardManifest(input, attempt)
  const sourcePages = input.sourcePages.map((page) => ({ ...page }))
  const normalizedInput: NormalizedLeaderboardRawArtifactSetInput = {
    sourceId: attempt.sourceId,
    sourceSlug: attempt.sourceSlug,
    timeframe: attempt.timeframe,
    sourceRunId: projection.sourceRunId,
    sourcePages,
    manifest,
    observationCycleId: attempt.observationCycleId,
  }
  validateLeaderboardRawArtifactSetCoordinates(normalizedInput)
  validateLeaderboardManifestPages(normalizedInput, manifest)

  const acquisitionAttemptMeta = Object.freeze({
    binding_contract: projection.binding.bindingContract,
    attempt_id: projection.binding.attemptId,
    attempt_seq: projection.binding.attemptSeq,
    runner_git_sha: projection.binding.runnerGitSha,
    capture_started_at: projection.binding.captureStartedAt,
    capture_completed_at: projection.binding.captureCompletedAt,
    capture_evidence_state: projection.captureEvidenceState,
    termination_reason: projection.terminationReason,
    source_page_count: projection.sourcePageCount,
    population_report_state: projection.populationReportState,
    reported_population: projection.reportedPopulation,
    page_count_report_state: projection.pageCountReportState,
    reported_page_count: projection.reportedPageCount,
    observed_population: projection.observedPopulation,
    accepted_population: projection.acceptedPopulation,
    rejected_row_count: projection.rejectedRowCount,
    deduplicated_row_count: projection.deduplicatedRowCount,
    caller_limited: projection.callerLimited,
    safety_limited: projection.safetyLimited,
    acquisition_state: projection.acquisitionState,
    population_state: projection.populationState,
    // Exhausted mode: the DB re-checks this block before an outcome may be
    // complete without a reported total (arena.leaderboard_exhaustion_completeness_holds).
    ...('completeness' in manifest && manifest.completeness
      ? { completeness: manifest.completeness }
      : {}),
  })
  const commonMeta = {
    surface: 'tier_a_leaderboard',
    source_run_id: normalizedInput.sourceRunId,
    ...(normalizedInput.observationCycleId
      ? { observation_cycle_id: normalizedInput.observationCycleId }
      : {}),
    acquisition_attempt: acquisitionAttemptMeta,
  }
  const artifacts = [
    prepareLeaderboardTrustArtifact(
      normalizedInput,
      'source_payload',
      normalizedInput.sourcePages,
      {
        ...commonMeta,
        pageCount: normalizedInput.sourcePages.length,
        parserPageCount: manifest.parser_input.page_count,
        parserSourcePageOrdinals: manifest.parser_input.transformation.source_page_ordinals,
      }
    ),
    prepareLeaderboardTrustArtifact(normalizedInput, 'population_manifest', manifest, {
      ...commonMeta,
      data_contract: manifest.data_contract,
    }),
  ] as const
  if (artifacts[1].contentHash !== normalizedInput.sourceRunId) {
    throw artifactSetError('serialized manifest digest does not match source run id')
  }
  if (artifacts[0].storagePath === artifacts[1].storagePath) {
    throw artifactSetError('source payload and manifest Storage paths must differ')
  }

  for (const artifact of artifacts) {
    artifact.durableCompressedBytes = await uploadDeterministicRaw(artifact)
  }
  const receipts = await runTransaction((transaction) =>
    persistLeaderboardTrustPointersInTransaction(transaction, normalizedInput, artifacts)
  )
  return { ...receipts, projection }
}

export type PositionHistoryRawArtifact =
  | HistoryAcquisitionArtifact
  | PositionHistoryAcquisitionArtifactV2

export interface WritePositionHistoryRawArtifactInput {
  sourceRunId: string
  artifact: PositionHistoryRawArtifact
}

export interface ReadVerifiedPositionHistoryRawArtifactV2Input {
  rawObjectId: number
  expectedSourceId: number
  expectedSourceSlug: string
  expectedTraderId: number
  expectedExchangeTraderId: string
  expectedSourceRunId: string
}

export type LockedVerifiedPositionHistoryRawArtifactV2 = Readonly<{
  contract: typeof POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT
  trustScope: 'acquisition_and_source_facts'
  acquisitionSourceRunId: string
  pointerSnapshot: Readonly<{
    rawObjectId: number
    sourceRunId: string
    storagePath: string
    fetchedAt: string
  }>
  candidateLedgerSha256: string
  artifact: PositionHistoryAcquisitionArtifactV2
}>

interface NormalizedPositionHistoryRawArtifactInput {
  sourceId: number
  sourceSlug: string
  traderId: number
  exchangeTraderId: string
  sourceRunId: string
  fetchedAt: string
  artifact: PositionHistoryRawArtifact
  acquisition: HistoryAcquisitionArtifact
}

interface PreparedPositionHistoryRawArtifact extends PreparedDeterministicRawArtifact {
  metaBase: Record<string, unknown>
}

interface PositionHistoryTrustPointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at: string
  storage_path: string
  bytes: number
  content_hash: string
  quarantined: boolean
  meta: unknown
  source_run_id: string | null
  trust_artifact_role: string | null
}

interface LockedPositionHistoryTrustPointerRow extends PositionHistoryTrustPointerRow {
  gc_pending: boolean
}

function positionHistoryArtifactError(detail: string): Error {
  return new Error(`[ingest] position-history RAW artifact failed: ${detail}`)
}

function normalizePositionHistoryRawArtifactInput(
  input: WritePositionHistoryRawArtifactInput
): NormalizedPositionHistoryRawArtifactInput {
  if (!/^[0-9a-f]{64}$/.test(input.sourceRunId)) {
    throw positionHistoryArtifactError('source run id must be a lowercase SHA-256 digest')
  }

  let artifact: PositionHistoryRawArtifact
  let acquisition: HistoryAcquisitionArtifact
  if (
    isRecord(input.artifact) &&
    input.artifact.contract === POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT
  ) {
    const verification = revalidatePositionHistoryAcquisitionArtifactV2({
      artifact: input.artifact,
      expectedSourceRunId: input.sourceRunId,
    })
    if (!verification.verified) {
      throw positionHistoryArtifactError(`history artifact v2 is invalid: ${verification.reason}`)
    }
    artifact = verification.artifact
    acquisition = verification.artifact.acquisition
  } else {
    try {
      acquisition = parseHistoryAcquisitionArtifact(input.artifact)
    } catch (cause) {
      throw positionHistoryArtifactError(`history artifact is invalid: ${asError(cause).message}`)
    }
    artifact = acquisition
    if (strictCanonicalSha256(artifact) !== input.sourceRunId) {
      throw positionHistoryArtifactError('canonical artifact hash does not match source run id')
    }
  }
  if (acquisition.history_kind !== 'position_history') {
    throw positionHistoryArtifactError('only position_history may bind the event_history role')
  }

  return {
    sourceId: acquisition.source.id,
    sourceSlug: acquisition.source.slug,
    traderId: acquisition.trader.id,
    exchangeTraderId: acquisition.trader.exchange_trader_id,
    sourceRunId: input.sourceRunId,
    fetchedAt: acquisition.pages.at(-1)?.fetched_at ?? acquisition.attempt_started_at,
    artifact,
    acquisition,
  }
}

function positionHistoryArtifactMetaBase(
  input: NormalizedPositionHistoryRawArtifactInput
): Record<string, unknown> {
  const acquisition = input.acquisition
  if (input.artifact.contract === POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT) {
    return {
      surface: 'position_history',
      data_contract: input.artifact.contract,
      source_run_id: input.sourceRunId,
      source_slug: input.sourceSlug,
      exchange_trader_id: input.exchangeTraderId,
      history_kind: acquisition.history_kind,
      attempt_started_at: acquisition.attempt_started_at,
      starting_cursor: acquisition.starting_cursor,
      capture_config: acquisition.capture_config,
      observed_at: input.fetchedAt,
      page_count: acquisition.pages.length,
      terminal_evidence_state: acquisition.termination.evidence_state,
      scan_terminal_state: acquisition.termination.scan_terminal_state,
      verifier_contract: acquisition.termination.verifier_contract,
      termination: acquisition.termination,
      acquisition_contract: input.artifact.acquisition.contract,
      acquisition_source_run_id: input.artifact.acquisition_source_run_id,
      candidate_ledger_contract: input.artifact.candidate_ledger.contract,
      candidate_ledger_sha256: input.artifact.candidate_ledger_sha256,
      source_fact_contract: input.artifact.candidate_ledger.source_fact_contract,
      observed_candidate_count: input.artifact.candidate_ledger.observed_candidate_count,
      unique_source_fact_count: input.artifact.candidate_ledger.unique_source_fact_count,
      fact_set_sha256: input.artifact.candidate_ledger.fact_set_sha256,
    }
  }

  return {
    surface: 'position_history',
    data_contract: input.artifact.contract,
    history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
    source_run_id: input.sourceRunId,
    source_slug: input.sourceSlug,
    exchange_trader_id: input.exchangeTraderId,
    history_kind: acquisition.history_kind,
    attempt_started_at: acquisition.attempt_started_at,
    starting_cursor: acquisition.starting_cursor,
    capture_config: acquisition.capture_config,
    observed_at: input.fetchedAt,
    page_count: acquisition.pages.length,
    terminal_evidence_state: acquisition.termination.evidence_state,
    scan_terminal_state: acquisition.termination.scan_terminal_state,
    verifier_contract: acquisition.termination.verifier_contract,
    termination: acquisition.termination,
  }
}

function preparePositionHistoryRawArtifact(
  input: NormalizedPositionHistoryRawArtifactInput
): PreparedPositionHistoryRawArtifact {
  const { json } = serializeRawPayload(input.artifact, STRICT_CANONICAL_JSON_CONTRACT)
  const jsonBytes = Buffer.from(json, 'utf8')
  if (
    input.artifact.contract === POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT &&
    jsonBytes.byteLength > POSITION_HISTORY_RAW_MAX_UNCOMPRESSED_BYTES
  ) {
    throw positionHistoryArtifactError('verified @2 artifact exceeds the trusted replay limit')
  }
  const gzipBytes = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== input.sourceRunId) {
    throw positionHistoryArtifactError('serialized artifact digest does not match source run id')
  }
  return {
    storagePath:
      `${input.sourceSlug}/history_trust/position_history/${input.sourceRunId}/` +
      `${EVENT_HISTORY_RAW_ARTIFACT_ROLE}_${contentHash}.json.gz`,
    jsonBytes,
    gzipBytes,
    contentHash,
    durableCompressedBytes: gzipBytes.byteLength,
    metaBase: positionHistoryArtifactMetaBase(input),
  }
}

function positionHistoryArtifactMeta(
  artifact: PreparedPositionHistoryRawArtifact
): Record<string, unknown> {
  return rawIntegrityMeta(
    artifact.metaBase,
    STRICT_CANONICAL_JSON_CONTRACT,
    artifact.durableCompressedBytes,
    artifact.jsonBytes.byteLength
  )
}

/**
 * Exact pre-publication-evidence metadata accepted only so an immutable RAW
 * pointer created by an older worker can still be replayed for audit. The
 * publication RPC requires the versioned contract above and therefore cannot
 * promote this compatibility shape into trusted serving data.
 */
function legacyPositionHistoryArtifactMeta(
  input: NormalizedPositionHistoryRawArtifactInput,
  artifact: PreparedPositionHistoryRawArtifact
): Record<string, unknown> | null {
  if (input.artifact.contract !== HISTORY_ACQUISITION_ARTIFACT_CONTRACT) return null

  return rawIntegrityMeta(
    {
      surface: 'position_history',
      data_contract: input.artifact.contract,
      source_run_id: input.sourceRunId,
      source_slug: input.sourceSlug,
      exchange_trader_id: input.exchangeTraderId,
      history_kind: input.acquisition.history_kind,
      page_count: input.acquisition.pages.length,
      terminal_evidence_state: input.acquisition.termination.evidence_state,
      scan_terminal_state: input.acquisition.termination.scan_terminal_state,
      verifier_contract: input.acquisition.termination.verifier_contract,
    },
    STRICT_CANONICAL_JSON_CONTRACT,
    artifact.durableCompressedBytes,
    artifact.jsonBytes.byteLength
  )
}

async function loadPositionHistoryTrustPointers(
  transaction: IngestQueryExecutor,
  artifact: PreparedPositionHistoryRawArtifact,
  sourceRunId: string
): Promise<PositionHistoryTrustPointerRow[]> {
  const { rows } = await transaction.query<PositionHistoryTrustPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at::text AS fetched_at, storage_path,
            bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role
       FROM arena.raw_objects
      WHERE storage_path = $1
         OR (
           source_run_id = $2
           AND trust_artifact_role = 'event_history'
         )
      ORDER BY id
      FOR UPDATE`,
    [artifact.storagePath, sourceRunId]
  )
  return rows
}

function validatePositionHistoryTrustPointer(
  rows: readonly PositionHistoryTrustPointerRow[],
  input: NormalizedPositionHistoryRawArtifactInput,
  artifact: PreparedPositionHistoryRawArtifact
): RawObjectReceipt {
  if (rows.length !== 1) {
    throw positionHistoryArtifactError(
      `expected one database pointer for ${input.sourceRunId}, found ${rows.length}`
    )
  }
  const row = rows[0]
  assertSafePositiveInteger(row.id, 'RAW pointer id', positionHistoryArtifactError)

  let metaMatches = false
  try {
    const storedMeta = strictCanonicalJson(row.meta)
    const legacyMeta = legacyPositionHistoryArtifactMeta(input, artifact)
    metaMatches =
      storedMeta === strictCanonicalJson(positionHistoryArtifactMeta(artifact)) ||
      (legacyMeta !== null && storedMeta === strictCanonicalJson(legacyMeta))
  } catch {
    metaMatches = false
  }
  if (
    row.source_id !== input.sourceId ||
    row.job_type !== POSITION_HISTORY_RAW_JOB_TYPE ||
    row.trader_id !== input.traderId ||
    row.timeframe !== null ||
    Date.parse(row.fetched_at) !== Date.parse(input.fetchedAt) ||
    row.storage_path !== artifact.storagePath ||
    row.bytes !== artifact.durableCompressedBytes ||
    row.content_hash !== input.sourceRunId ||
    row.quarantined !== false ||
    row.source_run_id !== input.sourceRunId ||
    row.trust_artifact_role !== EVENT_HISTORY_RAW_ARTIFACT_ROLE ||
    !metaMatches
  ) {
    throw positionHistoryArtifactError(`database pointer ${row.id} does not match the artifact`)
  }
  return {
    id: row.id,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
  }
}

async function insertPositionHistoryTrustPointer(
  transaction: IngestQueryExecutor,
  input: NormalizedPositionHistoryRawArtifactInput,
  artifact: PreparedPositionHistoryRawArtifact
): Promise<void> {
  await transaction.query(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
        bytes, content_hash, meta, source_run_id, trust_artifact_role)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (storage_path) DO NOTHING`,
    [
      input.sourceId,
      POSITION_HISTORY_RAW_JOB_TYPE,
      input.traderId,
      input.fetchedAt,
      artifact.storagePath,
      artifact.durableCompressedBytes,
      artifact.contentHash,
      JSON.stringify(positionHistoryArtifactMeta(artifact)),
      input.sourceRunId,
      EVENT_HISTORY_RAW_ARTIFACT_ROLE,
    ]
  )
}

async function persistPositionHistoryTrustPointer(
  transaction: IngestQueryExecutor,
  input: NormalizedPositionHistoryRawArtifactInput,
  artifact: PreparedPositionHistoryRawArtifact
): Promise<RawObjectReceipt> {
  await transaction.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`arena.position-history-raw-artifact:${input.sourceRunId}`]
  )

  let rows = await loadPositionHistoryTrustPointers(transaction, artifact, input.sourceRunId)
  if (rows.length === 0) {
    await insertPositionHistoryTrustPointer(transaction, input, artifact)
    rows = await loadPositionHistoryTrustPointers(transaction, artifact, input.sourceRunId)
  }
  return validatePositionHistoryTrustPointer(rows, input, artifact)
}

/**
 * Persist one immutable position-history acquisition artifact. A legacy @1
 * payload contains every captured upstream page plus its terminal proof or
 * explicit partial/unknown blocker. A verified @2 payload additionally binds a
 * replayed candidate ledger, but remains acquisition evidence only: it carries
 * no @1 publication-evidence marker and cannot claim parser or rank eligibility.
 * Storage is durable before the caller-owned transaction publishes the exact
 * source/trader pointer.
 */
export async function writePositionHistoryRawArtifact(
  input: WritePositionHistoryRawArtifactInput,
  runTransaction: IngestTransactionRunner
): Promise<RawObjectReceipt> {
  if (typeof runTransaction !== 'function') {
    throw positionHistoryArtifactError('a claimed transaction runner is required')
  }
  const normalizedInput = normalizePositionHistoryRawArtifactInput(input)
  const artifact = preparePositionHistoryRawArtifact(normalizedInput)
  artifact.durableCompressedBytes = await uploadDeterministicRaw(
    artifact,
    positionHistoryArtifactError
  )
  return runTransaction((transaction) =>
    persistPositionHistoryTrustPointer(transaction, normalizedInput, artifact)
  )
}

export interface WriteCopierSnapshotRawArtifactInput {
  artifact: CopierSnapshotArtifact
}

interface NormalizedCopierSnapshotRawArtifactInput {
  artifact: CopierSnapshotArtifact
  sourceRunId: string
  storagePath: string
  jobType: 'tier_c' | 'history:copiers'
}

interface CopierSnapshotRawPointerRow {
  id: number
  source_id: number
  job_type: string
  trader_id: number | null
  timeframe: number | null
  fetched_at: string
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

interface PreparedCopierSnapshotRawArtifact extends PreparedDeterministicRawArtifact {
  input: NormalizedCopierSnapshotRawArtifactInput
  metaBase: Record<string, unknown>
}

function copierSnapshotRawError(detail: string): Error {
  return new Error(`[ingest] copier snapshot RAW artifact failed: ${detail}`)
}

function normalizeCopierSnapshotRawArtifactInput(
  input: WriteCopierSnapshotRawArtifactInput
): NormalizedCopierSnapshotRawArtifactInput {
  const artifact = revalidateCopierSnapshotArtifact(input.artifact)
  const sourceRunId = copierSnapshotSourceRunId(artifact)
  const jobType = artifact.lane === 'tier_b' ? 'history:copiers' : 'tier_c'
  return {
    artifact,
    sourceRunId,
    jobType,
    storagePath: copierSnapshotStoragePath(artifact),
  }
}

function copierSnapshotRawMetaBase(
  input: NormalizedCopierSnapshotRawArtifactInput
): Record<string, unknown> {
  const artifact = input.artifact
  return {
    surface: 'copiers',
    data_contract: artifact.contract,
    source_run_id: input.sourceRunId,
    source_id: artifact.source.id,
    source_slug: artifact.source.slug,
    trader_id: artifact.trader.id,
    exchange_trader_id: artifact.trader.exchange_trader_id,
    lane: artifact.lane,
    request_timeframe: artifact.request_timeframe,
    observed_at: artifact.observed_at,
    page_count: artifact.page_count,
    scan_terminal_state: artifact.scan_terminal_state,
    caller_limited: artifact.caller_limited,
    source_reported_row_count: artifact.source_reported_row_count,
    source_depth: artifact.source.copier_table_depth,
    currency: artifact.source.currency,
    fetch_region: artifact.source.fetch_region,
    fetch_failed: false,
  }
}

function prepareCopierSnapshotRawArtifact(
  input: NormalizedCopierSnapshotRawArtifactInput
): PreparedCopierSnapshotRawArtifact {
  const { json } = serializeRawPayload(input.artifact, STRICT_CANONICAL_JSON_CONTRACT)
  const jsonBytes = Buffer.from(json, 'utf8')
  const gzipBytes = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== input.sourceRunId) {
    throw copierSnapshotRawError('serialized artifact digest does not match source run id')
  }
  return {
    input,
    storagePath: input.storagePath,
    jsonBytes,
    gzipBytes,
    contentHash,
    durableCompressedBytes: gzipBytes.byteLength,
    metaBase: copierSnapshotRawMetaBase(input),
  }
}

function copierSnapshotRawMeta(
  prepared: PreparedCopierSnapshotRawArtifact
): Record<string, unknown> {
  return rawIntegrityMeta(
    prepared.metaBase,
    STRICT_CANONICAL_JSON_CONTRACT,
    prepared.durableCompressedBytes,
    prepared.jsonBytes.byteLength
  )
}

async function loadCopierSnapshotRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotRawArtifact
): Promise<CopierSnapshotRawPointerRow[]> {
  const { rows } = await transaction.query<CopierSnapshotRawPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at::text AS fetched_at,
            fetched_at = $2::timestamptz AS fetched_at_exact,
            fetched_at <= statement_timestamp() + interval '5 minutes'
              AS observed_at_not_future,
            storage_path, bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role
       FROM arena.raw_objects
      WHERE storage_path = $1
      FOR UPDATE`,
    [prepared.storagePath, prepared.input.artifact.observed_at]
  )
  return rows
}

async function insertCopierSnapshotRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotRawArtifact
): Promise<void> {
  const artifact = prepared.input.artifact
  await transaction.query(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
        bytes, content_hash, meta, source_run_id, trust_artifact_role)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (storage_path) DO NOTHING`,
    [
      artifact.source.id,
      prepared.input.jobType,
      artifact.trader.id,
      artifact.observed_at,
      prepared.storagePath,
      prepared.durableCompressedBytes,
      prepared.contentHash,
      JSON.stringify(copierSnapshotRawMeta(prepared)),
      prepared.input.sourceRunId,
      COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE,
    ]
  )
}

function validateCopierSnapshotRawPointer(
  rows: readonly CopierSnapshotRawPointerRow[],
  prepared: PreparedCopierSnapshotRawArtifact
): RawObjectReceipt {
  if (rows.length !== 1) {
    throw copierSnapshotRawError(`expected one database pointer, found ${rows.length}`)
  }
  const row = rows[0]
  const artifact = prepared.input.artifact
  assertSafePositiveInteger(row.id, 'RAW pointer id', copierSnapshotRawError)

  let metaMatches = false
  try {
    metaMatches =
      strictCanonicalJson(row.meta) === strictCanonicalJson(copierSnapshotRawMeta(prepared))
  } catch {
    metaMatches = false
  }
  if (
    row.source_id !== artifact.source.id ||
    row.job_type !== prepared.input.jobType ||
    row.trader_id !== artifact.trader.id ||
    row.timeframe !== null ||
    row.fetched_at_exact !== true ||
    row.observed_at_not_future !== true ||
    row.storage_path !== prepared.storagePath ||
    row.bytes !== prepared.durableCompressedBytes ||
    row.content_hash !== prepared.input.sourceRunId ||
    row.quarantined !== false ||
    row.source_run_id !== prepared.input.sourceRunId ||
    row.trust_artifact_role !== COPIER_SNAPSHOT_RAW_ARTIFACT_ROLE ||
    !metaMatches
  ) {
    throw copierSnapshotRawError(`database pointer ${row.id} does not match the artifact`)
  }
  return {
    id: row.id,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
  }
}

async function persistCopierSnapshotRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotRawArtifact
): Promise<RawObjectReceipt> {
  await transaction.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`arena.copier-snapshot-raw-artifact:${prepared.storagePath}`]
  )
  let rows = await loadCopierSnapshotRawPointer(transaction, prepared)
  if (rows.length === 0) {
    await insertCopierSnapshotRawPointer(transaction, prepared)
    rows = await loadCopierSnapshotRawPointer(transaction, prepared)
  }
  return validateCopierSnapshotRawPointer(rows, prepared)
}

/**
 * Persist one deterministic, strict-canonical copier snapshot artifact.
 * Storage is durable before the caller-owned pointer transaction; an orphaned
 * blob is safe, while a pointer without durable bytes is never possible.
 */
export async function writeCopierSnapshotRawArtifact(
  input: WriteCopierSnapshotRawArtifactInput,
  runTransaction: IngestTransactionRunner
): Promise<RawObjectReceipt> {
  if (typeof runTransaction !== 'function') {
    throw copierSnapshotRawError('a claimed transaction runner is required')
  }
  const normalized = normalizeCopierSnapshotRawArtifactInput(input)
  const prepared = prepareCopierSnapshotRawArtifact(normalized)
  prepared.durableCompressedBytes = await uploadDeterministicRaw(prepared, copierSnapshotRawError)
  return runTransaction((transaction) => persistCopierSnapshotRawPointer(transaction, prepared))
}

export interface WriteCopierSnapshotTrustRawArtifactV2Input {
  readonly artifact: CopierSnapshotArtifactV2
  /** Immutable SHA-256 of the complete outer @2 artifact, supplied by its build result. */
  readonly sourceRunId: string
}

export interface CopierSnapshotTrustRawArtifactV2Receipt extends RawObjectReceipt {
  /** Outer @2 identity. It is also the pointer source_run_id and content_hash. */
  readonly sourceRunId: string
  readonly snapshotSourceRunId: string
  readonly candidateLedgerSha256: string
  readonly parserConservationSha256: string
  readonly projectionLedgerSha256: string
}

export interface ReadVerifiedCopierSnapshotTrustRawArtifactV2Input {
  readonly rawObjectId: number
  readonly expectedSourceId: number
  readonly expectedSourceSlug: string
  readonly expectedTraderId: number
  readonly expectedExchangeTraderId: string
  readonly expectedLane: 'tier_b' | 'tier_c'
  /** SHA-256 of the complete outer artifact@2 canonical bytes. */
  readonly expectedSourceRunId: string
  readonly expectedSnapshotSourceRunId: string
  readonly expectedCandidateLedgerSha256: string
  readonly expectedParserConservationSha256: string
  readonly expectedProjectionLedgerSha256: string
}

export type LockedVerifiedCopierSnapshotTrustRawArtifactV2 = Readonly<{
  contract: typeof COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT
  /** Evidence binding only; never a completeness, rank, or publication grant. */
  trustScope: 'raw_candidate_parser_projection_binding'
  pointerSnapshot: Readonly<{
    rawObjectId: number
    sourceRunId: string
    storagePath: string
    observedAt: string
  }>
  snapshotSourceRunId: string
  candidateLedgerSha256: string
  parserConservationSha256: string
  projectionLedgerSha256: string
  artifact: CopierSnapshotArtifactV2
}>

interface CapturedCopierSnapshotTrustRawArtifactV2Input {
  readonly artifact: unknown
  readonly sourceRunId: string
}

interface NormalizedCopierSnapshotTrustRawArtifactV2Input {
  readonly artifact: CopierSnapshotArtifactV2
  readonly sourceRunId: string
  readonly storagePath: string
  readonly jobType: 'tier_c' | 'history:copiers'
}

interface PreparedCopierSnapshotTrustRawArtifactV2 extends PreparedDeterministicRawArtifact {
  readonly input: NormalizedCopierSnapshotTrustRawArtifactV2Input
  readonly metaBase: Record<string, unknown>
}

interface CopierSnapshotTrustRawPointerRow {
  readonly id: number
  readonly source_id: number
  readonly job_type: string
  readonly trader_id: number | null
  readonly timeframe: number | null
  readonly fetched_at: string
  readonly fetched_at_exact: boolean
  readonly observed_at_not_future: boolean
  readonly storage_path: string
  readonly bytes: number
  readonly content_hash: string
  readonly quarantined: boolean
  readonly meta: unknown
  readonly source_run_id: string | null
  readonly trust_artifact_role: string | null
}

interface LockedCopierSnapshotTrustRawPointerRow extends CopierSnapshotTrustRawPointerRow {
  readonly gc_pending: boolean
}

function copierSnapshotTrustRawError(detail: string): Error {
  return new Error(`[ingest] copier snapshot trust RAW artifact failed: ${detail}`)
}

/** Capture the external anchor as a primitive before inspecting untrusted evidence. */
function captureCopierSnapshotTrustRawArtifactV2Input(
  input: unknown
): CapturedCopierSnapshotTrustRawArtifactV2Input {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)) {
    throw copierSnapshotTrustRawError('input must be a non-proxy plain object')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw copierSnapshotTrustRawError('input must be a non-proxy plain object')
  }
  const ownKeys = Reflect.ownKeys(input)
  if (ownKeys.length !== 2 || ownKeys.some((key) => key !== 'artifact' && key !== 'sourceRunId')) {
    throw copierSnapshotTrustRawError('input must have the exact contract fields')
  }

  const sourceRunDescriptor = Object.getOwnPropertyDescriptor(input, 'sourceRunId')
  if (
    !sourceRunDescriptor ||
    !sourceRunDescriptor.enumerable ||
    !('value' in sourceRunDescriptor)
  ) {
    throw copierSnapshotTrustRawError('input must contain enumerable data properties')
  }
  const sourceRunId: unknown = sourceRunDescriptor.value
  if (typeof sourceRunId !== 'string' || !/^[0-9a-f]{64}$/.test(sourceRunId)) {
    throw copierSnapshotTrustRawError('source run id must be a lowercase SHA-256 digest')
  }

  const artifactDescriptor = Object.getOwnPropertyDescriptor(input, 'artifact')
  if (!artifactDescriptor || !artifactDescriptor.enumerable || !('value' in artifactDescriptor)) {
    throw copierSnapshotTrustRawError('input must contain enumerable data properties')
  }
  return { sourceRunId, artifact: artifactDescriptor.value }
}

function normalizeCopierSnapshotTrustRawArtifactV2Input(
  captured: CapturedCopierSnapshotTrustRawArtifactV2Input
): NormalizedCopierSnapshotTrustRawArtifactV2Input {
  const verified = revalidateCopierSnapshotArtifactV2({
    artifact: captured.artifact,
    expectedSourceRunId: captured.sourceRunId,
  })
  const artifact = verified.artifact
  const snapshot = artifact.snapshot
  const sourceRunId = verified.sourceRunId
  return {
    artifact,
    sourceRunId,
    jobType: snapshot.lane === 'tier_b' ? 'history:copiers' : 'tier_c',
    storagePath:
      `${snapshot.source.slug}/copier_snapshot_trust/${snapshot.lane}/${sourceRunId}/` +
      `copier_snapshot_trust_${sourceRunId}.json.gz`,
  }
}

function copierSnapshotTrustRawMetaBase(
  input: NormalizedCopierSnapshotTrustRawArtifactV2Input
): Record<string, unknown> {
  const artifact = input.artifact
  const snapshot = artifact.snapshot
  return {
    surface: 'copiers',
    data_contract: COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
    source_run_id: input.sourceRunId,
    source_id: snapshot.source.id,
    source_slug: snapshot.source.slug,
    trader_id: snapshot.trader.id,
    lane: snapshot.lane,
    observed_at: snapshot.observed_at,
    snapshot_artifact_contract: snapshot.contract,
    snapshot_source_run_id: artifact.snapshot_source_run_id,
    candidate_ledger_contract: artifact.candidate_ledger.contract,
    candidate_ledger_sha256: artifact.candidate_ledger_sha256,
    parser_conservation_contract: artifact.parser_conservation.contract,
    parser_conservation_sha256: artifact.parser_conservation_sha256,
    projection_ledger_contract: artifact.projection_ledger.contract,
    projection_ledger_sha256: artifact.projection_ledger_sha256,
  }
}

function prepareCopierSnapshotTrustRawArtifactV2(
  input: NormalizedCopierSnapshotTrustRawArtifactV2Input
): PreparedCopierSnapshotTrustRawArtifactV2 {
  const { json } = serializeRawPayload(input.artifact, STRICT_CANONICAL_JSON_CONTRACT)
  const jsonBytes = Buffer.from(json, 'utf8')
  if (jsonBytes.byteLength > COPIER_SNAPSHOT_TRUST_RAW_MAX_UNCOMPRESSED_BYTES) {
    throw copierSnapshotTrustRawError('artifact exceeds the trusted replay limit')
  }
  const gzipBytes = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== input.sourceRunId) {
    throw copierSnapshotTrustRawError('serialized artifact digest does not match source run id')
  }
  return {
    input,
    storagePath: input.storagePath,
    jsonBytes,
    gzipBytes,
    contentHash,
    durableCompressedBytes: gzipBytes.byteLength,
    metaBase: copierSnapshotTrustRawMetaBase(input),
  }
}

function copierSnapshotTrustRawMeta(
  prepared: PreparedCopierSnapshotTrustRawArtifactV2
): Record<string, unknown> {
  return rawIntegrityMeta(
    prepared.metaBase,
    STRICT_CANONICAL_JSON_CONTRACT,
    prepared.durableCompressedBytes,
    prepared.jsonBytes.byteLength
  )
}

async function loadCopierSnapshotTrustRawPointers(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotTrustRawArtifactV2
): Promise<CopierSnapshotTrustRawPointerRow[]> {
  const artifact = prepared.input.artifact
  const { rows } = await transaction.query<CopierSnapshotTrustRawPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at::text AS fetched_at,
            fetched_at = $4::timestamptz AS fetched_at_exact,
            fetched_at <= statement_timestamp() + interval '5 minutes'
              AS observed_at_not_future,
            storage_path, bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role
       FROM arena.raw_objects
      WHERE storage_path = $1
         OR (
           source_run_id = $2
           AND trust_artifact_role = $3
         )
      ORDER BY id
      FOR UPDATE`,
    [
      prepared.storagePath,
      prepared.input.sourceRunId,
      COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
      artifact.snapshot.observed_at,
    ]
  )
  return rows
}

async function insertCopierSnapshotTrustRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotTrustRawArtifactV2
): Promise<void> {
  const snapshot = prepared.input.artifact.snapshot
  await transaction.query(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
        bytes, content_hash, meta, source_run_id, trust_artifact_role)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (storage_path) DO NOTHING`,
    [
      snapshot.source.id,
      prepared.input.jobType,
      snapshot.trader.id,
      snapshot.observed_at,
      prepared.storagePath,
      prepared.durableCompressedBytes,
      prepared.contentHash,
      JSON.stringify(copierSnapshotTrustRawMeta(prepared)),
      prepared.input.sourceRunId,
      COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE,
    ]
  )
}

function validateCopierSnapshotTrustRawPointer(
  rows: readonly CopierSnapshotTrustRawPointerRow[],
  prepared: PreparedCopierSnapshotTrustRawArtifactV2
): CopierSnapshotTrustRawArtifactV2Receipt {
  if (rows.length !== 1) {
    throw copierSnapshotTrustRawError(`expected one database pointer, found ${rows.length}`)
  }
  const row = rows[0]
  const artifact = prepared.input.artifact
  const snapshot = artifact.snapshot
  assertSafePositiveInteger(row.id, 'RAW pointer id', copierSnapshotTrustRawError)

  let metaMatches = false
  try {
    metaMatches =
      strictCanonicalJson(row.meta) === strictCanonicalJson(copierSnapshotTrustRawMeta(prepared))
  } catch {
    metaMatches = false
  }
  if (
    row.source_id !== snapshot.source.id ||
    row.job_type !== prepared.input.jobType ||
    row.trader_id !== snapshot.trader.id ||
    row.timeframe !== null ||
    row.fetched_at_exact !== true ||
    row.observed_at_not_future !== true ||
    row.storage_path !== prepared.storagePath ||
    row.bytes !== prepared.durableCompressedBytes ||
    row.content_hash !== prepared.input.sourceRunId ||
    row.quarantined !== false ||
    row.source_run_id !== prepared.input.sourceRunId ||
    row.trust_artifact_role !== COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE ||
    !metaMatches
  ) {
    throw copierSnapshotTrustRawError(`database pointer ${row.id} does not match the artifact`)
  }
  return Object.freeze({
    id: row.id,
    storagePath: row.storage_path,
    contentHash: row.content_hash,
    sourceRunId: prepared.input.sourceRunId,
    snapshotSourceRunId: artifact.snapshot_source_run_id,
    candidateLedgerSha256: artifact.candidate_ledger_sha256,
    parserConservationSha256: artifact.parser_conservation_sha256,
    projectionLedgerSha256: artifact.projection_ledger_sha256,
  })
}

async function persistCopierSnapshotTrustRawPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedCopierSnapshotTrustRawArtifactV2
): Promise<CopierSnapshotTrustRawArtifactV2Receipt> {
  await transaction.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [`arena.copier-snapshot-trust-raw-artifact:${prepared.input.sourceRunId}`]
  )
  let rows = await loadCopierSnapshotTrustRawPointers(transaction, prepared)
  if (rows.length === 0) {
    await insertCopierSnapshotTrustRawPointer(transaction, prepared)
    rows = await loadCopierSnapshotTrustRawPointers(transaction, prepared)
  }
  return validateCopierSnapshotTrustRawPointer(rows, prepared)
}

/**
 * Persist independently replayable @2 copier evidence. The externally supplied
 * outer digest is captured and semantically revalidated before Storage I/O.
 * This receipt proves durable bytes and an exact private pointer only; it grants
 * neither completeness nor ranking/publication authority.
 */
export async function writeCopierSnapshotTrustRawArtifactV2(
  input: WriteCopierSnapshotTrustRawArtifactV2Input,
  runTransaction: IngestTransactionRunner
): Promise<CopierSnapshotTrustRawArtifactV2Receipt> {
  if (typeof runTransaction !== 'function') {
    throw copierSnapshotTrustRawError('a claimed transaction runner is required')
  }
  const captured = captureCopierSnapshotTrustRawArtifactV2Input(input)
  const outerDigest = strictCanonicalJsonDigestWithinLimit(
    captured.artifact,
    COPIER_SNAPSHOT_TRUST_RAW_MAX_UNCOMPRESSED_BYTES
  )
  if (!outerDigest.withinLimit) {
    throw copierSnapshotTrustRawError('artifact exceeds the trusted replay limit')
  }
  if (outerDigest.sha256 !== captured.sourceRunId) {
    throw copierSnapshotTrustRawError(
      'outer artifact does not match its immutable source-run anchor'
    )
  }
  const normalized = normalizeCopierSnapshotTrustRawArtifactV2Input(captured)
  const prepared = prepareCopierSnapshotTrustRawArtifactV2(normalized)
  prepared.durableCompressedBytes = await uploadDeterministicRaw(
    prepared,
    copierSnapshotTrustRawError
  )
  return runTransaction((transaction) =>
    persistCopierSnapshotTrustRawPointer(transaction, prepared)
  )
}

interface PreparedRawObjectPointer {
  contentHash: string
  storagePath: string
  values: readonly unknown[]
}

async function persistRawObjectPointer(
  transaction: IngestQueryExecutor,
  prepared: PreparedRawObjectPointer
): Promise<RawObjectReceipt> {
  const { rows } = await transaction.query<{ id: number }>(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, storage_path, bytes, content_hash, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    prepared.values
  )
  return {
    id: rows[0].id,
    storagePath: prepared.storagePath,
    contentHash: prepared.contentHash,
  }
}

/**
 * Write one raw payload. Tier-A job types require the execution claim's
 * transaction runner; lower tiers retain their direct-pointer compatibility.
 */
export function writeRawObject(
  input: WriteRawInput<TierARawJobType>,
  runTransaction: IngestTransactionRunner
): Promise<RawObjectReceipt>
export function writeRawObject(
  input: WriteRawInput<NonTierARawJobType>,
  runTransaction?: IngestTransactionRunner
): Promise<RawObjectReceipt>
export async function writeRawObject(
  input: WriteRawInput,
  runTransaction?: IngestTransactionRunner
): Promise<RawObjectReceipt> {
  if (TIER_A_RAW_JOB_TYPES.has(input.jobType)) {
    assertTierARawTransactionRunner(runTransaction)
  }
  const { json, serializationContract } = serializeRawPayload(input.payload, input.serialization)
  const jsonBytes = Buffer.from(json, 'utf8')
  const gz = gzipSync(jsonBytes)
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  const meta = {
    ...(input.meta ?? {}),
    // Computed fields intentionally win over caller metadata. Readers use this
    // contract to distinguish new, fully verifiable blobs from legacy rows.
    raw_integrity: {
      version: 1,
      content_type: 'application/json',
      encoding: 'utf-8',
      compression: 'gzip',
      hash_algorithm: 'sha256',
      hash_scope: 'json_utf8',
      serialization_contract: serializationContract,
      compressed_bytes: gz.byteLength,
      uncompressed_bytes: jsonBytes.byteLength,
    },
  }

  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const storagePath =
    `${input.sourceSlug}/${input.jobType}/${yyyy}/${mm}/${dd}/` +
    `${now.getTime()}_${contentHash}.json.gz`
  const prepared: PreparedRawObjectPointer = {
    contentHash,
    storagePath,
    values: Object.freeze([
      input.sourceId,
      input.jobType,
      input.traderId ?? null,
      input.timeframe ?? null,
      storagePath,
      gz.byteLength,
      contentHash,
      JSON.stringify(meta),
    ]),
  }

  await uploadRawPayload(storagePath, gz)

  if (runTransaction) {
    return runTransaction((transaction) => persistRawObjectPointer(transaction, prepared))
  }
  return persistRawObjectPointer(getIngestPool(), prepared)
}

interface ReadRawPayloadResult {
  payload: unknown
  compressedBytes: number
  uncompressedBytes: number
}

function cancelRawDownloadReader(
  reader: ReadableStreamDefaultReader<unknown>,
  reason: Error
): void {
  try {
    void reader.cancel(reason).catch(() => undefined)
  } catch {
    // The original bounded-read failure is authoritative; cancellation is best effort.
  }
}

const rawTypedArrayTagGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag
)?.get as ((this: unknown) => unknown) | undefined

function isRawDownloadByteChunk(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || rawTypedArrayTagGetter === undefined) return false
  try {
    return Reflect.apply(rawTypedArrayTagGetter, value, []) === 'Uint8Array'
  } catch {
    return false
  }
}

async function readBoundedRawDownload(
  rawObjectId: number,
  pointer: RawObjectPointer,
  maxCompressedBytes: number
): Promise<Buffer> {
  const download = getStorageClient().storage.from(RAW_BUCKET).download(pointer.storage_path)
  let data: ReadableStream<unknown> | null
  let error: { message?: string } | null
  try {
    ;({ data, error } = await download.asStream())
  } catch (cause) {
    throw new Error(
      `[ingest] RAW stream download failed (${pointer.storage_path}): ${asError(cause).message}`
    )
  }
  if (error || !data || typeof data.getReader !== 'function') {
    throw new Error(
      `[ingest] RAW stream download failed (${pointer.storage_path}): ${error?.message ?? 'empty stream body'}`
    )
  }

  let reader: ReadableStreamDefaultReader<unknown>
  try {
    reader = data.getReader()
  } catch (cause) {
    throw new Error(
      `[ingest] RAW stream reader failed (${pointer.storage_path}): ${asError(cause).message}`
    )
  }
  const gz = Buffer.allocUnsafe(pointer.bytes)
  let offset = 0
  try {
    while (true) {
      let result: ReadableStreamReadResult<unknown>
      try {
        result = await reader.read()
      } catch (cause) {
        const streamError = new Error(
          `[ingest] RAW stream body failed (${pointer.storage_path}): ${asError(cause).message}`
        )
        cancelRawDownloadReader(reader, streamError)
        throw streamError
      }

      if (result.done === true) {
        if (result.value !== undefined) {
          const malformed = rawIntegrityError(
            rawObjectId,
            pointer.storage_path,
            'stream EOF contained an unexpected chunk'
          )
          cancelRawDownloadReader(reader, malformed)
          throw malformed
        }
        break
      }
      if (result.done !== false || !isRawDownloadByteChunk(result.value)) {
        const malformed = rawIntegrityError(
          rawObjectId,
          pointer.storage_path,
          'stream returned a non-byte chunk'
        )
        cancelRawDownloadReader(reader, malformed)
        throw malformed
      }
      const chunk = result.value
      if (
        chunk.byteLength === 0 ||
        chunk.byteLength > maxCompressedBytes - offset ||
        chunk.byteLength > pointer.bytes - offset
      ) {
        const oversized = rawIntegrityError(
          rawObjectId,
          pointer.storage_path,
          'Storage object exceeds the compressed byte limit'
        )
        cancelRawDownloadReader(reader, oversized)
        throw oversized
      }
      gz.set(chunk, offset)
      offset += chunk.byteLength
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A failed/mocked stream may already have released its reader.
    }
  }

  if (offset !== pointer.bytes) {
    throw rawIntegrityError(
      rawObjectId,
      pointer.storage_path,
      `compressed byte count mismatch (expected ${pointer.bytes}, received ${offset})`
    )
  }
  return gz
}

async function readRawPayload(
  rawObjectId: number,
  pointer: RawObjectPointer,
  options: { maxCompressedBytes?: number; maxUncompressedBytes?: number } = {}
): Promise<ReadRawPayloadResult> {
  if (
    options.maxCompressedBytes !== undefined &&
    (!Number.isSafeInteger(options.maxCompressedBytes) || options.maxCompressedBytes < 0)
  ) {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'compressed byte limit is invalid')
  }
  if (!Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0) {
    throw rawIntegrityError(
      rawObjectId,
      pointer.storage_path,
      'stored compressed byte count is invalid'
    )
  }
  let gz: Buffer
  if (options.maxCompressedBytes !== undefined) {
    if (pointer.bytes > options.maxCompressedBytes) {
      throw rawIntegrityError(
        rawObjectId,
        pointer.storage_path,
        'stored compressed byte count exceeds the compressed byte limit'
      )
    }
    gz = await readBoundedRawDownload(rawObjectId, pointer, options.maxCompressedBytes)
  } else {
    const { data, error } = await getStorageClient()
      .storage.from(RAW_BUCKET)
      .download(pointer.storage_path)
    if (error || !data) {
      throw new Error(`[ingest] RAW download failed (${pointer.storage_path}): ${error?.message}`)
    }
    try {
      gz = Buffer.from(await data.arrayBuffer())
    } catch (downloadError) {
      throw new Error(
        `[ingest] RAW download body failed (${pointer.storage_path}): ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`
      )
    }
  }
  if (gz.byteLength !== pointer.bytes) {
    throw rawIntegrityError(
      rawObjectId,
      pointer.storage_path,
      `compressed byte count mismatch (expected ${pointer.bytes}, received ${gz.byteLength})`
    )
  }
  if (gz.byteLength < 3 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08) {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'invalid gzip header')
  }

  let jsonBytes: Buffer
  try {
    // gunzip validates the gzip trailer CRC32 and original-size fields.
    jsonBytes = gunzipSync(
      gz,
      options.maxUncompressedBytes === undefined
        ? undefined
        : { maxOutputLength: options.maxUncompressedBytes }
    )
  } catch {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'gzip payload or trailer is corrupt')
  }

  const serializationContract = verifyRawIntegrityMetadata(
    rawObjectId,
    pointer.storage_path,
    pointer.meta,
    gz.byteLength,
    jsonBytes.byteLength
  )

  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(pointer.content_hash)) {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'stored SHA-256 format is invalid')
  }
  const fullHash = createHash('sha256').update(jsonBytes).digest('hex')
  const expectedHash = pointer.content_hash.length === 32 ? fullHash.slice(0, 32) : fullHash
  if (pointer.content_hash !== expectedHash) {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'SHA-256 checksum mismatch')
  }

  let json: string
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
  } catch {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'payload is not valid UTF-8')
  }

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'payload is not valid JSON')
  }

  if (serializationContract === STRICT_CANONICAL_JSON_CONTRACT) {
    let canonicalJson: string
    try {
      canonicalJson = strictCanonicalJson(payload)
    } catch {
      throw rawIntegrityError(
        rawObjectId,
        pointer.storage_path,
        'strict canonical serialization mismatch'
      )
    }
    if (canonicalJson !== json) {
      throw rawIntegrityError(
        rawObjectId,
        pointer.storage_path,
        'strict canonical serialization mismatch'
      )
    }
  }
  return {
    payload,
    compressedBytes: gz.byteLength,
    uncompressedBytes: jsonBytes.byteLength,
  }
}

/**
 * Re-read a stored raw payload (re-parse path, spec §5.5).
 * This generic compatibility reader verifies stored bytes, not trust-pointer
 * identity or source-specific semantics. Callers must not use it as a trusted
 * position-history @2 replay or publication authority.
 */
export async function readRawObject(rawObjectId: number): Promise<unknown> {
  const { rows } = await getIngestPool().query<RawObjectPointer>(
    `SELECT storage_path, bytes, content_hash, meta
     FROM arena.raw_objects
     WHERE id = $1`,
    [rawObjectId]
  )
  if (rows.length === 0) {
    throw new Error(`[ingest] raw object ${rawObjectId} not found`)
  }
  return (await readRawPayload(rawObjectId, rows[0])).payload
}

const VERIFIED_COPIER_SNAPSHOT_TRUST_RAW_INPUT_FIELDS = Object.freeze([
  'rawObjectId',
  'expectedSourceId',
  'expectedSourceSlug',
  'expectedTraderId',
  'expectedExchangeTraderId',
  'expectedLane',
  'expectedSourceRunId',
  'expectedSnapshotSourceRunId',
  'expectedCandidateLedgerSha256',
  'expectedParserConservationSha256',
  'expectedProjectionLedgerSha256',
] as const)

function verifiedCopierSnapshotTrustRawReadError(
  rawObjectId: number | null,
  detail: string
): Error {
  return new Error(
    `[ingest] verified copier snapshot trust RAW read failed (id=${rawObjectId ?? 'unread'}): ${detail}`
  )
}

function captureVerifiedCopierSnapshotTrustRawReadInput(
  value: unknown
): ReadVerifiedCopierSnapshotTrustRawArtifactV2Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'input must be a non-proxy plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'input must be a non-proxy plain object')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== VERIFIED_COPIER_SNAPSHOT_TRUST_RAW_INPUT_FIELDS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !VERIFIED_COPIER_SNAPSHOT_TRUST_RAW_INPUT_FIELDS.includes(
          key as (typeof VERIFIED_COPIER_SNAPSHOT_TRUST_RAW_INPUT_FIELDS)[number]
        )
    )
  ) {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'input must have the exact anchor fields')
  }

  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of VERIFIED_COPIER_SNAPSHOT_TRUST_RAW_INPUT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw verifiedCopierSnapshotTrustRawReadError(
        null,
        'input anchors must be enumerable data properties'
      )
    }
    captured[field] = descriptor.value
  }

  const rawObjectId = captured.rawObjectId
  const sourceId = captured.expectedSourceId
  const traderId = captured.expectedTraderId
  if (typeof rawObjectId !== 'number' || !Number.isSafeInteger(rawObjectId) || rawObjectId <= 0) {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'raw object id is invalid')
  }
  if (typeof sourceId !== 'number' || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw verifiedCopierSnapshotTrustRawReadError(rawObjectId, 'expected source id is invalid')
  }
  if (typeof traderId !== 'number' || !Number.isSafeInteger(traderId) || traderId <= 0) {
    throw verifiedCopierSnapshotTrustRawReadError(rawObjectId, 'expected trader id is invalid')
  }
  const sourceSlug = captured.expectedSourceSlug
  if (typeof sourceSlug !== 'string' || !/^[a-z0-9][a-z0-9_]{0,127}$/.test(sourceSlug)) {
    throw verifiedCopierSnapshotTrustRawReadError(rawObjectId, 'expected source slug is invalid')
  }
  const exchangeTraderId = captured.expectedExchangeTraderId
  if (
    typeof exchangeTraderId !== 'string' ||
    exchangeTraderId.length < 1 ||
    exchangeTraderId.length > 512 ||
    exchangeTraderId.trim() !== exchangeTraderId
  ) {
    throw verifiedCopierSnapshotTrustRawReadError(
      rawObjectId,
      'expected exchange trader id is invalid'
    )
  }
  const lane = captured.expectedLane
  if (lane !== 'tier_b' && lane !== 'tier_c') {
    throw verifiedCopierSnapshotTrustRawReadError(rawObjectId, 'expected lane is invalid')
  }
  for (const [label, digest] of [
    ['outer source run id', captured.expectedSourceRunId],
    ['snapshot source run id', captured.expectedSnapshotSourceRunId],
    ['candidate ledger digest', captured.expectedCandidateLedgerSha256],
    ['parser conservation digest', captured.expectedParserConservationSha256],
    ['projection ledger digest', captured.expectedProjectionLedgerSha256],
  ] as const) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw verifiedCopierSnapshotTrustRawReadError(rawObjectId, `expected ${label} is invalid`)
    }
  }

  return Object.freeze({
    rawObjectId,
    expectedSourceId: sourceId,
    expectedSourceSlug: sourceSlug,
    expectedTraderId: traderId,
    expectedExchangeTraderId: exchangeTraderId,
    expectedLane: lane,
    expectedSourceRunId: captured.expectedSourceRunId as string,
    expectedSnapshotSourceRunId: captured.expectedSnapshotSourceRunId as string,
    expectedCandidateLedgerSha256: captured.expectedCandidateLedgerSha256 as string,
    expectedParserConservationSha256: captured.expectedParserConservationSha256 as string,
    expectedProjectionLedgerSha256: captured.expectedProjectionLedgerSha256 as string,
  })
}

async function loadLockedCopierSnapshotTrustRawPointers(
  transaction: IngestQueryExecutor,
  input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input
): Promise<LockedCopierSnapshotTrustRawPointerRow[]> {
  const { rows } = await transaction.query<LockedCopierSnapshotTrustRawPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at::text AS fetched_at, storage_path,
            bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role,
            EXISTS (
              SELECT 1
              FROM arena.raw_object_gc_queue AS gc
              WHERE gc.storage_path = raw_object.storage_path
            ) AS gc_pending
       FROM arena.raw_objects AS raw_object
      WHERE raw_object.id = $1
         OR (
           raw_object.source_run_id = $2
           AND raw_object.trust_artifact_role = $3
         )
      ORDER BY raw_object.id
      FOR SHARE`,
    [input.rawObjectId, input.expectedSourceRunId, COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE]
  )
  return rows
}

function expectedCopierSnapshotTrustRawReadMeta(
  input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  observedAt: string,
  compressedBytes: number,
  uncompressedBytes: number
): Record<string, unknown> {
  return rawIntegrityMeta(
    {
      surface: 'copiers',
      data_contract: COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
      source_run_id: input.expectedSourceRunId,
      source_id: input.expectedSourceId,
      source_slug: input.expectedSourceSlug,
      trader_id: input.expectedTraderId,
      lane: input.expectedLane,
      observed_at: observedAt,
      snapshot_artifact_contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
      snapshot_source_run_id: input.expectedSnapshotSourceRunId,
      candidate_ledger_contract: COPIER_CANDIDATE_LEDGER_CONTRACT,
      candidate_ledger_sha256: input.expectedCandidateLedgerSha256,
      parser_conservation_contract: COPIER_PARSER_CONSERVATION_CONTRACT,
      parser_conservation_sha256: input.expectedParserConservationSha256,
      projection_ledger_contract: COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT,
      projection_ledger_sha256: input.expectedProjectionLedgerSha256,
    },
    STRICT_CANONICAL_JSON_CONTRACT,
    compressedBytes,
    uncompressedBytes
  )
}

interface ValidatedLockedCopierSnapshotTrustRawPointer {
  readonly pointer: LockedCopierSnapshotTrustRawPointerRow
  readonly observedAt: string
  readonly uncompressedBytes: number
  readonly maxCompressedBytes: number
}

function validateLockedCopierSnapshotTrustRawPointer(
  rows: readonly LockedCopierSnapshotTrustRawPointerRow[],
  input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input
): ValidatedLockedCopierSnapshotTrustRawPointer {
  if (rows.length !== 1) {
    throw verifiedCopierSnapshotTrustRawReadError(
      input.rawObjectId,
      `expected one locked pointer for the outer source run, found ${rows.length}`
    )
  }
  const pointer = rows[0]
  const expectedJobType = input.expectedLane === 'tier_b' ? 'history:copiers' : 'tier_c'
  const expectedStoragePath =
    `${input.expectedSourceSlug}/copier_snapshot_trust/${input.expectedLane}/` +
    `${input.expectedSourceRunId}/copier_snapshot_trust_${input.expectedSourceRunId}.json.gz`

  let meta: Record<string, unknown> | null = null
  let serializedMeta: string | null = null
  try {
    serializedMeta = strictCanonicalJson(pointer.meta)
    const parsed: unknown = JSON.parse(serializedMeta)
    meta = isRecord(parsed) ? parsed : null
  } catch {
    meta = null
  }
  const rawIntegrity = meta && isRecord(meta.raw_integrity) ? meta.raw_integrity : null
  const observedAt = meta?.observed_at
  const observedEpoch = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN
  const uncompressedBytes = rawIntegrity?.uncompressed_bytes
  const maxCompressedBytes =
    typeof uncompressedBytes === 'number' &&
    Number.isSafeInteger(uncompressedBytes) &&
    uncompressedBytes > 0 &&
    uncompressedBytes <= COPIER_SNAPSHOT_TRUST_RAW_MAX_UNCOMPRESSED_BYTES
      ? deterministicRawMaxCompressedBytesForUncompressedBytes(uncompressedBytes)
      : -1
  const expectedMeta =
    typeof observedAt === 'string' && maxCompressedBytes >= 0
      ? expectedCopierSnapshotTrustRawReadMeta(
          input,
          observedAt,
          pointer.bytes,
          uncompressedBytes as number
        )
      : null
  let metaMatches = false
  try {
    metaMatches =
      serializedMeta !== null &&
      expectedMeta !== null &&
      serializedMeta === strictCanonicalJson(expectedMeta)
  } catch {
    metaMatches = false
  }

  if (
    pointer.id !== input.rawObjectId ||
    pointer.source_id !== input.expectedSourceId ||
    pointer.job_type !== expectedJobType ||
    pointer.trader_id !== input.expectedTraderId ||
    pointer.timeframe !== null ||
    typeof pointer.fetched_at !== 'string' ||
    !Number.isFinite(Date.parse(pointer.fetched_at)) ||
    pointer.storage_path !== expectedStoragePath ||
    !Number.isSafeInteger(pointer.bytes) ||
    pointer.bytes <= 0 ||
    maxCompressedBytes < 0 ||
    pointer.bytes > maxCompressedBytes ||
    pointer.content_hash !== input.expectedSourceRunId ||
    pointer.quarantined !== false ||
    pointer.gc_pending !== false ||
    pointer.source_run_id !== input.expectedSourceRunId ||
    pointer.trust_artifact_role !== COPIER_SNAPSHOT_TRUST_RAW_ARTIFACT_ROLE ||
    typeof observedAt !== 'string' ||
    !Number.isFinite(observedEpoch) ||
    new Date(observedEpoch).toISOString() !== observedAt ||
    !metaMatches
  ) {
    throw verifiedCopierSnapshotTrustRawReadError(
      input.rawObjectId,
      'locked pointer does not match the expected artifact@2 identity'
    )
  }

  return Object.freeze({
    pointer,
    observedAt,
    uncompressedBytes: uncompressedBytes as number,
    maxCompressedBytes,
  })
}

async function validateLockedCopierSnapshotTrustFetchedAt(
  transaction: IngestQueryExecutor,
  rawObjectId: number,
  expectedFetchedAt: string
): Promise<void> {
  const { rows } = await transaction.query<{ exact_instant: boolean; not_future: boolean }>(
    `SELECT fetched_at = $2::timestamptz AS exact_instant,
            fetched_at <= pg_catalog.statement_timestamp() + interval '5 minutes' AS not_future
       FROM arena.raw_objects
      WHERE id = $1`,
    [rawObjectId, expectedFetchedAt]
  )
  if (rows.length !== 1 || rows[0].exact_instant !== true || rows[0].not_future !== true) {
    throw verifiedCopierSnapshotTrustRawReadError(
      rawObjectId,
      'locked pointer timestamp does not match the artifact@2 observation clock'
    )
  }
}

/**
 * Lock, read, and replay one copier artifact@2 under independently supplied
 * pointer, account, outer, and child-hash anchors, then consume it inside the
 * same caller-owned transaction. The evidence binds captured RAW candidates to
 * their parser and projection only. It grants no capture completeness, rank
 * eligibility, publication permission, or authority over current database
 * source/trader rows; consumers must lock and validate those rows separately.
 * Retaining the frozen evidence after this callback grants no additional trust.
 */
export async function withVerifiedCopierSnapshotTrustRawArtifactV2<T>(
  input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  runTransaction: IngestTransactionRunner,
  consume: (
    transaction: IngestQueryExecutor,
    evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2
  ) => Promise<T>
): Promise<T> {
  // Function authority is checked before inspecting a possibly hostile input envelope.
  if (typeof runTransaction !== 'function') {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'a claimed transaction runner is required')
  }
  if (typeof consume !== 'function') {
    throw verifiedCopierSnapshotTrustRawReadError(null, 'a locked consumer is required')
  }
  const captured = captureVerifiedCopierSnapshotTrustRawReadInput(input)

  return runTransaction(async (transaction) => {
    await transaction.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
      [`arena.copier-snapshot-trust-raw-artifact:${captured.expectedSourceRunId}`]
    )
    const locked = validateLockedCopierSnapshotTrustRawPointer(
      await loadLockedCopierSnapshotTrustRawPointers(transaction, captured),
      captured
    )
    const raw = await readRawPayload(captured.rawObjectId, locked.pointer, {
      // The locked pointer is both below the policy ceiling and the exact byte count.
      maxCompressedBytes: Math.min(locked.maxCompressedBytes, locked.pointer.bytes),
      maxUncompressedBytes: locked.uncompressedBytes,
    })
    let verified: ReturnType<typeof revalidateCopierSnapshotArtifactV2>
    try {
      verified = revalidateCopierSnapshotArtifactV2({
        artifact: raw.payload,
        expectedSourceRunId: captured.expectedSourceRunId,
      })
    } catch (cause) {
      throw verifiedCopierSnapshotTrustRawReadError(
        captured.rawObjectId,
        `artifact@2 semantic replay failed: ${asError(cause).message}`
      )
    }
    const artifact = verified.artifact
    const snapshot = artifact.snapshot
    if (
      snapshot.source.id !== captured.expectedSourceId ||
      snapshot.source.slug !== captured.expectedSourceSlug ||
      snapshot.trader.id !== captured.expectedTraderId ||
      snapshot.trader.exchange_trader_id !== captured.expectedExchangeTraderId ||
      snapshot.lane !== captured.expectedLane ||
      artifact.snapshot_source_run_id !== captured.expectedSnapshotSourceRunId ||
      artifact.candidate_ledger_sha256 !== captured.expectedCandidateLedgerSha256 ||
      artifact.parser_conservation_sha256 !== captured.expectedParserConservationSha256 ||
      artifact.projection_ledger_sha256 !== captured.expectedProjectionLedgerSha256
    ) {
      throw verifiedCopierSnapshotTrustRawReadError(
        captured.rawObjectId,
        'artifact@2 coordinates or child anchors do not match the locked pointer'
      )
    }
    await validateLockedCopierSnapshotTrustFetchedAt(
      transaction,
      captured.rawObjectId,
      snapshot.observed_at
    )

    const expectedMeta = rawIntegrityMeta(
      copierSnapshotTrustRawMetaBase({
        artifact,
        sourceRunId: captured.expectedSourceRunId,
        storagePath: locked.pointer.storage_path,
        jobType: captured.expectedLane === 'tier_b' ? 'history:copiers' : 'tier_c',
      }),
      STRICT_CANONICAL_JSON_CONTRACT,
      raw.compressedBytes,
      raw.uncompressedBytes
    )
    let metaMatches = false
    try {
      metaMatches = strictCanonicalJson(locked.pointer.meta) === strictCanonicalJson(expectedMeta)
    } catch {
      metaMatches = false
    }
    if (!metaMatches) {
      throw verifiedCopierSnapshotTrustRawReadError(
        captured.rawObjectId,
        'locked pointer metadata is not the exact artifact@2 evidence contract'
      )
    }

    const evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2 = Object.freeze({
      contract: COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
      trustScope: 'raw_candidate_parser_projection_binding',
      pointerSnapshot: Object.freeze({
        rawObjectId: captured.rawObjectId,
        sourceRunId: captured.expectedSourceRunId,
        storagePath: locked.pointer.storage_path,
        observedAt: snapshot.observed_at,
      }),
      snapshotSourceRunId: artifact.snapshot_source_run_id,
      candidateLedgerSha256: artifact.candidate_ledger_sha256,
      parserConservationSha256: artifact.parser_conservation_sha256,
      projectionLedgerSha256: artifact.projection_ledger_sha256,
      artifact,
    })
    const result = await consume(transaction, evidence)

    const reloaded = validateLockedCopierSnapshotTrustRawPointer(
      await loadLockedCopierSnapshotTrustRawPointers(transaction, captured),
      captured
    )
    if (strictCanonicalJson(reloaded.pointer) !== strictCanonicalJson(locked.pointer)) {
      throw verifiedCopierSnapshotTrustRawReadError(
        captured.rawObjectId,
        'locked pointer changed during artifact@2 consumption'
      )
    }
    return result
  })
}

function verifiedPositionHistoryRawReadError(rawObjectId: number, detail: string): Error {
  return new Error(
    `[ingest] verified position-history RAW read failed (id=${rawObjectId}): ${detail}`
  )
}

function validateVerifiedPositionHistoryRawReadInput(
  input: ReadVerifiedPositionHistoryRawArtifactV2Input
): void {
  if (!Number.isSafeInteger(input.rawObjectId) || input.rawObjectId <= 0) {
    throw verifiedPositionHistoryRawReadError(input.rawObjectId, 'raw object id is invalid')
  }
  if (!Number.isSafeInteger(input.expectedSourceId) || input.expectedSourceId <= 0) {
    throw verifiedPositionHistoryRawReadError(input.rawObjectId, 'expected source id is invalid')
  }
  if (!Number.isSafeInteger(input.expectedTraderId) || input.expectedTraderId <= 0) {
    throw verifiedPositionHistoryRawReadError(input.rawObjectId, 'expected trader id is invalid')
  }
  if (!/^[a-z0-9_]+$/.test(input.expectedSourceSlug)) {
    throw verifiedPositionHistoryRawReadError(input.rawObjectId, 'expected source slug is invalid')
  }
  if (
    typeof input.expectedExchangeTraderId !== 'string' ||
    input.expectedExchangeTraderId.length === 0 ||
    input.expectedExchangeTraderId.trim() !== input.expectedExchangeTraderId
  ) {
    throw verifiedPositionHistoryRawReadError(
      input.rawObjectId,
      'expected exchange trader id is invalid'
    )
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedSourceRunId)) {
    throw verifiedPositionHistoryRawReadError(
      input.rawObjectId,
      'expected outer source run id is invalid'
    )
  }
}

async function loadLockedPositionHistoryTrustPointers(
  transaction: IngestQueryExecutor,
  input: ReadVerifiedPositionHistoryRawArtifactV2Input
): Promise<LockedPositionHistoryTrustPointerRow[]> {
  const { rows } = await transaction.query<LockedPositionHistoryTrustPointerRow>(
    `SELECT id, source_id, job_type, trader_id, timeframe,
            fetched_at::text AS fetched_at, storage_path,
            bytes, content_hash, quarantined, meta,
            source_run_id, trust_artifact_role,
            EXISTS (
              SELECT 1
              FROM arena.raw_object_gc_queue AS gc
              WHERE gc.storage_path = raw_object.storage_path
            ) AS gc_pending
       FROM arena.raw_objects AS raw_object
      WHERE raw_object.id = $1
         OR (
           raw_object.source_run_id = $2
           AND raw_object.trust_artifact_role = 'event_history'
         )
      ORDER BY raw_object.id
      FOR SHARE`,
    [input.rawObjectId, input.expectedSourceRunId]
  )
  return rows
}

function validateLockedPositionHistoryV2Pointer(
  rows: readonly LockedPositionHistoryTrustPointerRow[],
  input: ReadVerifiedPositionHistoryRawArtifactV2Input
): LockedPositionHistoryTrustPointerRow {
  if (rows.length !== 1) {
    throw verifiedPositionHistoryRawReadError(
      input.rawObjectId,
      `expected one locked pointer for the outer source run, found ${rows.length}`
    )
  }
  const pointer = rows[0]
  const expectedStoragePath =
    `${input.expectedSourceSlug}/history_trust/position_history/` +
    `${input.expectedSourceRunId}/${EVENT_HISTORY_RAW_ARTIFACT_ROLE}_` +
    `${input.expectedSourceRunId}.json.gz`
  const fetchedAt = Date.parse(pointer.fetched_at)
  const meta = pointer.meta
  const rawIntegrity = isRecord(meta) ? meta.raw_integrity : null
  if (
    pointer.id !== input.rawObjectId ||
    pointer.source_id !== input.expectedSourceId ||
    pointer.job_type !== POSITION_HISTORY_RAW_JOB_TYPE ||
    pointer.trader_id !== input.expectedTraderId ||
    pointer.timeframe !== null ||
    !Number.isFinite(fetchedAt) ||
    pointer.storage_path !== expectedStoragePath ||
    !Number.isSafeInteger(pointer.bytes) ||
    pointer.bytes <= 0 ||
    pointer.content_hash !== input.expectedSourceRunId ||
    pointer.quarantined !== false ||
    pointer.gc_pending !== false ||
    pointer.source_run_id !== input.expectedSourceRunId ||
    pointer.trust_artifact_role !== EVENT_HISTORY_RAW_ARTIFACT_ROLE ||
    !isRecord(meta) ||
    meta.surface !== 'position_history' ||
    meta.data_contract !== POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT ||
    meta.source_run_id !== input.expectedSourceRunId ||
    meta.source_slug !== input.expectedSourceSlug ||
    meta.exchange_trader_id !== input.expectedExchangeTraderId ||
    meta.history_kind !== 'position_history' ||
    !isRecord(rawIntegrity) ||
    rawIntegrity.version !== 1 ||
    rawIntegrity.content_type !== 'application/json' ||
    rawIntegrity.encoding !== 'utf-8' ||
    rawIntegrity.compression !== 'gzip' ||
    rawIntegrity.hash_algorithm !== 'sha256' ||
    rawIntegrity.hash_scope !== 'json_utf8' ||
    rawIntegrity.serialization_contract !== STRICT_CANONICAL_JSON_CONTRACT ||
    rawIntegrity.compressed_bytes !== pointer.bytes ||
    !Number.isSafeInteger(rawIntegrity.uncompressed_bytes) ||
    Number(rawIntegrity.uncompressed_bytes) <= 0 ||
    Number(rawIntegrity.uncompressed_bytes) > POSITION_HISTORY_RAW_MAX_UNCOMPRESSED_BYTES
  ) {
    throw verifiedPositionHistoryRawReadError(
      input.rawObjectId,
      'locked pointer does not match the expected @2 identity'
    )
  }
  return pointer
}

async function validateLockedPositionHistoryFetchedAt(
  transaction: IngestQueryExecutor,
  rawObjectId: number,
  expectedFetchedAt: string
): Promise<void> {
  const { rows } = await transaction.query<{
    exact_instant: boolean
    not_future: boolean
  }>(
    `SELECT fetched_at = $2::timestamptz AS exact_instant,
            fetched_at <= pg_catalog.statement_timestamp() + interval '5 minutes' AS not_future
       FROM arena.raw_objects
      WHERE id = $1`,
    [rawObjectId, expectedFetchedAt]
  )
  if (rows.length !== 1 || rows[0].exact_instant !== true || rows[0].not_future !== true) {
    throw verifiedPositionHistoryRawReadError(
      rawObjectId,
      'locked pointer timestamp does not match the @2 observation clock'
    )
  }
}

/**
 * Lock and semantically replay one position-history @2 acquisition under its
 * independently captured source/trader/run anchor, then consume it inside the
 * same caller-owned transaction. The advisory and row locks keep GC,
 * quarantine, and pointer rebinding from racing the Storage read or consumer.
 * The snapshot proves acquisition and source facts only; retaining it after
 * the callback does not confer parser, price/cost, publication, or rank trust.
 * It also does not attest the current sources/traders rows: a projection or
 * publication consumer must re-lock and bind those identities in this same
 * transaction instead of treating the expected input as current authority.
 */
export async function withVerifiedPositionHistoryRawArtifactV2<T>(
  input: ReadVerifiedPositionHistoryRawArtifactV2Input,
  runTransaction: IngestTransactionRunner,
  consume: (
    transaction: IngestQueryExecutor,
    evidence: LockedVerifiedPositionHistoryRawArtifactV2
  ) => Promise<T>
): Promise<T> {
  validateVerifiedPositionHistoryRawReadInput(input)
  if (typeof runTransaction !== 'function') {
    throw verifiedPositionHistoryRawReadError(
      input.rawObjectId,
      'a claimed transaction runner is required'
    )
  }
  if (typeof consume !== 'function') {
    throw verifiedPositionHistoryRawReadError(input.rawObjectId, 'a locked consumer is required')
  }

  return runTransaction(async (transaction) => {
    await transaction.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
      [`arena.position-history-raw-artifact:${input.expectedSourceRunId}`]
    )
    const pointer = validateLockedPositionHistoryV2Pointer(
      await loadLockedPositionHistoryTrustPointers(transaction, input),
      input
    )
    const rawIntegrity = (pointer.meta as Record<string, unknown>).raw_integrity as Record<
      string,
      unknown
    >
    const raw = await readRawPayload(input.rawObjectId, pointer, {
      maxUncompressedBytes: Number(rawIntegrity.uncompressed_bytes),
    })
    const verification = revalidatePositionHistoryAcquisitionArtifactV2({
      artifact: raw.payload,
      expectedSourceRunId: input.expectedSourceRunId,
    })
    if (!verification.verified) {
      throw verifiedPositionHistoryRawReadError(
        input.rawObjectId,
        `@2 semantic replay failed: ${verification.reason}`
      )
    }

    const artifact = verification.artifact
    const acquisition = artifact.acquisition
    const fetchedAt = acquisition.pages.at(-1)?.fetched_at ?? acquisition.attempt_started_at
    if (
      acquisition.source.id !== input.expectedSourceId ||
      acquisition.source.slug !== input.expectedSourceSlug ||
      acquisition.trader.id !== input.expectedTraderId ||
      acquisition.trader.exchange_trader_id !== input.expectedExchangeTraderId
    ) {
      throw verifiedPositionHistoryRawReadError(
        input.rawObjectId,
        '@2 payload coordinates do not match the locked pointer'
      )
    }
    await validateLockedPositionHistoryFetchedAt(transaction, input.rawObjectId, fetchedAt)

    const normalized: NormalizedPositionHistoryRawArtifactInput = {
      sourceId: input.expectedSourceId,
      sourceSlug: input.expectedSourceSlug,
      traderId: input.expectedTraderId,
      exchangeTraderId: input.expectedExchangeTraderId,
      sourceRunId: input.expectedSourceRunId,
      fetchedAt,
      artifact,
      acquisition,
    }
    const expectedMeta = rawIntegrityMeta(
      positionHistoryArtifactMetaBase(normalized),
      STRICT_CANONICAL_JSON_CONTRACT,
      raw.compressedBytes,
      raw.uncompressedBytes
    )
    let metaMatches = false
    try {
      metaMatches = strictCanonicalJson(pointer.meta) === strictCanonicalJson(expectedMeta)
    } catch {
      metaMatches = false
    }
    if (!metaMatches) {
      throw verifiedPositionHistoryRawReadError(
        input.rawObjectId,
        'locked pointer metadata is not the exact @2 evidence contract'
      )
    }

    const evidence: LockedVerifiedPositionHistoryRawArtifactV2 = Object.freeze({
      contract: POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
      trustScope: 'acquisition_and_source_facts',
      acquisitionSourceRunId: artifact.acquisition_source_run_id,
      pointerSnapshot: Object.freeze({
        rawObjectId: input.rawObjectId,
        sourceRunId: input.expectedSourceRunId,
        storagePath: pointer.storage_path,
        fetchedAt,
      }),
      candidateLedgerSha256: verification.candidateLedgerSha256,
      artifact,
    })
    const result = await consume(transaction, evidence)

    // The consumer shares this transaction so it can persist a projection,
    // but it must never mutate the evidence pointer that authorizes its work.
    const reloaded = validateLockedPositionHistoryV2Pointer(
      await loadLockedPositionHistoryTrustPointers(transaction, input),
      input
    )
    if (strictCanonicalJson(reloaded) !== strictCanonicalJson(pointer)) {
      throw verifiedPositionHistoryRawReadError(
        input.rawObjectId,
        'locked pointer changed during @2 consumption'
      )
    }
    return result
  })
}

/**
 * Remove already-detached objects from the raw-snapshots bucket. Callers must
 * only pass paths taken from a durable GC queue row (pointer outbox or the
 * orphan queue of 20261118134316); this never decides what is garbage.
 */
export async function removeRawStorageObjects(
  storagePaths: readonly string[]
): Promise<{ error: string | null }> {
  if (storagePaths.length === 0) return { error: null }
  const { error } = await getStorageClient()
    .storage.from(RAW_BUCKET)
    .remove([...storagePaths])
  if (!error) return { error: null }
  return { error: error.message?.trim() || 'unknown Storage error' }
}

async function readRawObjectGcBatch(client: PoolClient): Promise<RawObjectGcPointer[]> {
  const { rows } = await client.query<RawObjectGcPointer>(
    `SELECT storage_path
       FROM arena.raw_object_gc_queue
      ORDER BY coalesce(last_attempt_at, enqueued_at), enqueued_at, storage_path
      LIMIT 500`
  )
  return rows
}

async function drainRawObjectGcBatch(
  client: PoolClient,
  rows: RawObjectGcPointer[]
): Promise<number> {
  if (rows.length === 0) return 0

  const storagePaths = rows.map((row) => row.storage_path)
  const storage = getStorageClient().storage.from(RAW_BUCKET)
  const { error } = await storage.remove(storagePaths)
  if (error) {
    // arena.raw_object_gc_queue_attempt_shape (20260721130000) requires a
    // non-blank last_error once attempts > 0. A blank Storage message would
    // violate it and lose the durable retry bookkeeping.
    const message = error.message?.trim() || 'unknown Storage error'
    try {
      await client.query(
        `UPDATE arena.raw_object_gc_queue
            SET attempts = attempts + 1,
                last_attempt_at = now(),
                last_error = $2
          WHERE storage_path = ANY($1::text[])`,
        [storagePaths, message.slice(0, 2_000)]
      )
    } catch (recordError) {
      throw new Error(
        `[ingest] RAW cleanup remove failed; durable queue bookkeeping also failed: ${message}; ${recordError instanceof Error ? recordError.message : String(recordError)}`
      )
    }
    throw new Error(`[ingest] RAW cleanup remove failed; durable queue retained: ${message}`)
  }

  await client.query(
    `DELETE FROM arena.raw_object_gc_queue
      WHERE storage_path = ANY($1::text[])`,
    [storagePaths]
  )
  return storagePaths.length
}

/**
 * Delete raw objects older than the retention window (skips quarantined).
 * The database pointer is deleted only in the same statement that durably
 * enqueues its Storage path. This makes ranking fail closed before external
 * deletion and leaves a retryable outbox across worker or Storage failures.
 * Returns the number of Storage objects removed. Called by maintenance.ts.
 */
/**
 * Does this database carry metric-trust evidence tables? Before
 * 20260721120000 is applied there is nothing to pin.
 */
export const METRIC_TRUST_EVIDENCE_PRESENT_SQL = `SELECT
  pg_catalog.to_regclass('arena.metric_trust_runs') IS NOT NULL
  AND pg_catalog.to_regclass('arena.metric_trust_artifacts') IS NOT NULL
  AND pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL AS present`

/**
 * RAW retention candidates. Objects referenced by metric-trust evidence
 * (run population/manifest, observation artifacts) are pinned: deleting them
 * used to CASCADE away the trust runs and observations, breaking the
 * audit/replay chain after 30 days (20261113* makes those FKs RESTRICT).
 * The board payload a snapshot soft-references (leaderboard_snapshots.
 * raw_object_id, the only RAW evidence of a no-trust-path board) is pinned
 * while the snapshot exists, and retires with it (snapshot retention,
 * 20261113110021).
 */
export function rawObjectRetentionCandidateSql(trustEvidencePresent: boolean): string {
  const pinned = trustEvidencePresent
    ? `
            AND NOT EXISTS (
              SELECT 1 FROM arena.metric_trust_runs AS run
               WHERE run.population_raw_object_id = raw_candidate.id
                  OR run.manifest_raw_object_id = raw_candidate.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM arena.metric_trust_artifacts AS artifact
               WHERE artifact.raw_object_id = raw_candidate.id
            )`
    : ''
  return `SELECT raw_candidate.id, raw_candidate.storage_path, raw_candidate.content_hash
           FROM arena.raw_objects AS raw_candidate
          WHERE NOT raw_candidate.quarantined
            AND raw_candidate.fetched_at < now() - ($1 || ' days')::interval
            AND NOT EXISTS (
              SELECT 1 FROM arena.leaderboard_snapshots AS snapshot
               WHERE snapshot.raw_object_id = raw_candidate.id
            )${pinned}
          ORDER BY raw_candidate.fetched_at, raw_candidate.id
          FOR UPDATE OF raw_candidate SKIP LOCKED
          LIMIT 500`
}

export async function cleanupRawObjects(retentionDays = 30): Promise<number> {
  const client = await ingestClientConnect()
  let lockAcquired = false
  let destroyClient = false
  try {
    const { rows: lockRows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_catalog.pg_try_advisory_lock(${RAW_GC_ADVISORY_LOCK}) AS acquired`
    )
    lockAcquired = lockRows[0]?.acquired === true
    if (!lockAcquired) return 0

    // Drain prior failures before retiring more evidence so a Storage outage
    // cannot grow the durable queue without bound on every maintenance run.
    const pending = await readRawObjectGcBatch(client)
    if (pending.length > 0) return drainRawObjectGcBatch(client, pending)

    const { rows: evidenceRows } = await client.query<{ present: boolean }>(
      METRIC_TRUST_EVIDENCE_PRESENT_SQL
    )
    await client.query(
      `WITH candidates AS MATERIALIZED (
         ${rawObjectRetentionCandidateSql(evidenceRows[0]?.present === true)}
       ), queued AS (
         INSERT INTO arena.raw_object_gc_queue
           (raw_object_id, storage_path, content_hash)
         SELECT id, storage_path, content_hash
           FROM candidates
         ON CONFLICT (storage_path) DO NOTHING
         RETURNING raw_object_id
       )
       DELETE FROM arena.raw_objects AS raw
        USING queued
        WHERE raw.id = queued.raw_object_id`,
      [retentionDays]
    )

    return drainRawObjectGcBatch(client, await readRawObjectGcBatch(client))
  } finally {
    if (lockAcquired) {
      try {
        const { rows } = await client.query<{ unlocked: boolean }>(
          `SELECT pg_catalog.pg_advisory_unlock(${RAW_GC_ADVISORY_LOCK}) AS unlocked`
        )
        if (rows[0]?.unlocked !== true) {
          destroyClient = true
          console.error(
            '[ingest] RAW cleanup advisory unlock returned false; destroying pooled session'
          )
        }
      } catch (error) {
        // Never return a possibly lock-owning session to the pool. A dropped
        // PostgreSQL session already released the lock; destroying a healthy
        // but query-failed session releases it deterministically.
        destroyClient = true
        console.error(
          '[ingest] RAW cleanup advisory unlock failed; destroying pooled session:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    client.release(destroyClient)
  }
}
