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
import { gzipSync, gunzipSync } from 'node:zlib'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PoolClient } from 'pg'
import { getIngestPool, ingestClientConnect } from './db'
import type { RankingTimeframe, RawPage } from './core/types'
import {
  parseLeaderboardAcquisitionManifest,
  type LeaderboardAcquisitionManifest,
} from './acquisition-manifest'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const RAW_BUCKET = 'raw-snapshots'

let storageClient: SupabaseClient | null = null

const RAW_UPLOAD_ATTEMPTS = 3
const RAW_UPLOAD_RETRY_BASE_MS = 750
const RAW_GC_ADVISORY_LOCK = "pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)"

export const RAW_JSON_STRINGIFY_CONTRACT = 'arena.raw-json-stringify@1' as const
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

export interface WriteRawInput {
  sourceId: number
  sourceSlug: string
  jobType: string // tier_a | tier_b | tier_c | tier_d | history:<kind> | bots
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

export interface WriteLeaderboardRawArtifactSetInput {
  sourceId: number
  sourceSlug: string
  timeframe: RankingTimeframe
  sourceRunId: string
  sourcePages: RawPage[]
  manifest: LeaderboardAcquisitionManifest
  observationCycleId: string | null
}

export interface LeaderboardRawArtifactSetReceipt {
  sourcePayload: RawObjectReceipt
  populationManifest: RawObjectReceipt
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

interface PreparedLeaderboardTrustArtifact {
  role: LeaderboardTrustArtifactRole
  jobType: 'tier_a' | 'tier_a_manifest'
  storagePath: string
  jsonBytes: Buffer
  gzipBytes: Buffer
  contentHash: string
  metaBase: Record<string, unknown>
  durableCompressedBytes: number
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

function assertSafePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw artifactSetError(`${label} must be a positive safe integer`)
  }
}

function validateLeaderboardRawArtifactSetInput(
  input: WriteLeaderboardRawArtifactSetInput
): LeaderboardAcquisitionManifest {
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

  const manifest = parseLeaderboardAcquisitionManifest(input.manifest)
  if (strictCanonicalSha256(manifest) !== input.sourceRunId) {
    throw artifactSetError('canonical manifest hash does not match source run id')
  }
  if (
    manifest.source.id !== input.sourceId ||
    manifest.source.slug !== input.sourceSlug ||
    manifest.timeframe !== input.timeframe ||
    manifest.observation_cycle_id !== input.observationCycleId
  ) {
    throw artifactSetError('manifest source, timeframe, or cycle binding does not match the input')
  }
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
  if (transformation.kind !== 'identity_projection') {
    throw artifactSetError(
      'dedupe/rechunk parser evidence requires a separately persisted parser payload'
    )
  }
  const reconstructedParserPages = transformation.source_page_ordinals.map(
    (ordinal) => input.sourcePages[ordinal - 1]
  )
  if (
    reconstructedParserPages.some((page) => page === undefined) ||
    manifest.parser_input.page_count !== reconstructedParserPages.length ||
    strictCanonicalSha256(reconstructedParserPages) !== manifest.parser_input.sha256
  ) {
    throw artifactSetError('parser input digest does not match the persisted source pages')
  }
  return manifest
}

function prepareLeaderboardTrustArtifact(
  input: WriteLeaderboardRawArtifactSetInput,
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
  artifact: PreparedLeaderboardTrustArtifact
): Promise<number> {
  const { data, error } = await getStorageClient()
    .storage.from(RAW_BUCKET)
    .download(artifact.storagePath)
  if (error || !data) {
    throw artifactSetError(
      `cannot verify existing Storage object ${artifact.storagePath}: ${error?.message ?? 'empty body'}`
    )
  }

  let gzipBytes: Buffer
  try {
    gzipBytes = Buffer.from(await data.arrayBuffer())
  } catch (cause) {
    throw artifactSetError(
      `cannot read existing Storage object ${artifact.storagePath}: ${asError(cause).message}`
    )
  }
  if (
    gzipBytes.byteLength < 3 ||
    gzipBytes[0] !== 0x1f ||
    gzipBytes[1] !== 0x8b ||
    gzipBytes[2] !== 0x08
  ) {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} is not gzip`)
  }

  let jsonBytes: Buffer
  try {
    jsonBytes = gunzipSync(gzipBytes)
  } catch {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} has invalid gzip data`)
  }
  if (!jsonBytes.equals(artifact.jsonBytes)) {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} has different content`)
  }
  const contentHash = createHash('sha256').update(jsonBytes).digest('hex')
  if (contentHash !== artifact.contentHash) {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} has a digest mismatch`)
  }
  let parsed: unknown
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
    parsed = JSON.parse(json)
  } catch {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} is not canonical JSON`)
  }
  if (strictCanonicalJson(parsed) !== artifact.jsonBytes.toString('utf8')) {
    throw artifactSetError(`existing Storage object ${artifact.storagePath} is not canonical JSON`)
  }
  return gzipBytes.byteLength
}

async function uploadDeterministicRaw(artifact: PreparedLeaderboardTrustArtifact): Promise<number> {
  const bucket = getStorageClient().storage.from(RAW_BUCKET)
  for (let attempt = 1; attempt <= RAW_UPLOAD_ATTEMPTS; attempt += 1) {
    const { error } = await bucket.upload(artifact.storagePath, artifact.gzipBytes, {
      contentType: 'application/gzip',
      upsert: false,
    })
    if (!error) return artifact.gzipBytes.byteLength
    if (isAlreadyUploaded(error)) return verifyExistingDeterministicRaw(artifact)
    if (attempt === RAW_UPLOAD_ATTEMPTS || !isTransientStorageError(error)) {
      throw artifactSetError(`Storage upload failed (${artifact.storagePath}): ${error.message}`)
    }
    const delayMs = RAW_UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw artifactSetError(`Storage upload attempts exhausted (${artifact.storagePath})`)
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
  client: PoolClient,
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
  input: WriteLeaderboardRawArtifactSetInput,
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
  client: PoolClient,
  input: WriteLeaderboardRawArtifactSetInput,
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
  client: PoolClient,
  input: WriteLeaderboardRawArtifactSetInput,
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

async function reconcileLeaderboardTrustCommit(
  input: WriteLeaderboardRawArtifactSetInput,
  artifacts: readonly PreparedLeaderboardTrustArtifact[],
  commitError: unknown
): Promise<LeaderboardRawArtifactSetReceipt> {
  let client: PoolClient
  try {
    client = await ingestClientConnect()
  } catch (cause) {
    throw new AggregateError(
      [asError(commitError), asError(cause)],
      '[ingest] leaderboard RAW commit outcome and reconciliation both failed'
    )
  }
  try {
    const rows = await loadLeaderboardTrustPointers(client, artifacts, input.sourceRunId, false)
    return validateLeaderboardTrustPointers(rows, artifacts, input, false).receipts
  } catch (cause) {
    throw new AggregateError(
      [asError(commitError), asError(cause)],
      '[ingest] leaderboard RAW commit outcome is unresolved'
    )
  } finally {
    client.release()
  }
}

async function persistLeaderboardTrustPointers(
  input: WriteLeaderboardRawArtifactSetInput,
  artifacts: readonly PreparedLeaderboardTrustArtifact[]
): Promise<LeaderboardRawArtifactSetReceipt> {
  const client = await ingestClientConnect()
  let inTransaction = false
  let commitAttempted = false
  let destroyClient = false
  let failure: unknown = null
  let receipts: LeaderboardRawArtifactSetReceipt | null = null

  try {
    await client.query('BEGIN')
    inTransaction = true
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(
      `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
      [`arena.leaderboard-raw-artifact-set:${input.sourceRunId}`]
    )

    const existing = await loadLeaderboardTrustPointers(client, artifacts, input.sourceRunId, true)
    if (existing.length === 0) {
      for (const artifact of artifacts) {
        await insertLeaderboardTrustPointer(client, input, artifact)
      }
    } else if (existing.length !== artifacts.length) {
      throw artifactSetError('database contains only part of the expected RAW pointer pair')
    }

    let verified = validateLeaderboardTrustPointers(
      existing.length === 0
        ? await loadLeaderboardTrustPointers(client, artifacts, input.sourceRunId, true)
        : existing,
      artifacts,
      input,
      true
    )
    if (verified.state === 'unbound') {
      await bindUnboundLeaderboardTrustPointers(client, input, artifacts, verified.receipts)
      verified = validateLeaderboardTrustPointers(
        await loadLeaderboardTrustPointers(client, artifacts, input.sourceRunId, true),
        artifacts,
        input,
        false
      )
    }
    receipts = verified.receipts

    commitAttempted = true
    await client.query('COMMIT')
    inTransaction = false
  } catch (cause) {
    failure = cause
    if (commitAttempted) {
      destroyClient = true
    } else if (inTransaction) {
      try {
        await client.query('ROLLBACK')
        inTransaction = false
      } catch (rollbackCause) {
        destroyClient = true
        failure = new AggregateError(
          [asError(cause), asError(rollbackCause)],
          '[ingest] leaderboard RAW transaction and rollback both failed'
        )
      }
    }
  } finally {
    client.release(destroyClient)
  }

  if (failure !== null) {
    if (commitAttempted) {
      return reconcileLeaderboardTrustCommit(input, artifacts, failure)
    }
    throw failure
  }
  if (receipts === null) throw artifactSetError('transaction committed without RAW receipts')
  return receipts
}

/**
 * Persist one capture payload and its canonical population manifest as an
 * idempotent pair. Storage is written before the short PG transaction; a
 * deterministic retry verifies any existing object byte-for-byte and returns
 * the same database pointers. No failure path deletes Storage evidence.
 */
export async function writeLeaderboardRawArtifactSet(
  input: WriteLeaderboardRawArtifactSetInput
): Promise<LeaderboardRawArtifactSetReceipt> {
  const manifest = validateLeaderboardRawArtifactSetInput(input)
  // Snapshot every later-read binding before the first Storage await. Callers
  // cannot race a mutable input object against the database transaction.
  const normalizedInput: WriteLeaderboardRawArtifactSetInput = {
    sourceId: input.sourceId,
    sourceSlug: input.sourceSlug,
    timeframe: input.timeframe,
    sourceRunId: input.sourceRunId,
    sourcePages: [...input.sourcePages],
    manifest,
    observationCycleId: input.observationCycleId,
  }
  const commonMeta = {
    surface: 'tier_a_leaderboard',
    source_run_id: normalizedInput.sourceRunId,
    ...(normalizedInput.observationCycleId
      ? { observation_cycle_id: normalizedInput.observationCycleId }
      : {}),
  }
  const artifacts = [
    prepareLeaderboardTrustArtifact(
      normalizedInput,
      'source_payload',
      normalizedInput.sourcePages,
      {
        ...commonMeta,
        pageCount: normalizedInput.sourcePages.length,
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
  return persistLeaderboardTrustPointers(normalizedInput, artifacts)
}

/** Write one raw payload; returns its durable pointer and computed content identity. */
export async function writeRawObject(input: WriteRawInput): Promise<RawObjectReceipt> {
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

  await uploadRawPayload(storagePath, gz)

  const { rows } = await getIngestPool().query<{ id: number }>(
    `INSERT INTO arena.raw_objects
       (source_id, job_type, trader_id, timeframe, storage_path, bytes, content_hash, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.sourceId,
      input.jobType,
      input.traderId ?? null,
      input.timeframe ?? null,
      storagePath,
      gz.byteLength,
      contentHash,
      JSON.stringify(meta),
    ]
  )
  return {
    id: rows[0].id,
    storagePath,
    contentHash,
  }
}

/** Re-read a stored raw payload (re-parse path, spec §5.5). */
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
  const pointer = rows[0]
  const { data, error } = await getStorageClient()
    .storage.from(RAW_BUCKET)
    .download(pointer.storage_path)
  if (error || !data) {
    throw new Error(`[ingest] RAW download failed (${pointer.storage_path}): ${error?.message}`)
  }

  let gz: Buffer
  try {
    gz = Buffer.from(await data.arrayBuffer())
  } catch (downloadError) {
    throw new Error(
      `[ingest] RAW download body failed (${pointer.storage_path}): ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`
    )
  }

  if (!Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0) {
    throw rawIntegrityError(
      rawObjectId,
      pointer.storage_path,
      'stored compressed byte count is invalid'
    )
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
    jsonBytes = gunzipSync(gz)
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
  return payload
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
    const message = error.message ?? 'unknown Storage error'
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

    await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT id, storage_path, content_hash
           FROM arena.raw_objects
          WHERE NOT quarantined
            AND fetched_at < now() - ($1 || ' days')::interval
          ORDER BY fetched_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 500
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
