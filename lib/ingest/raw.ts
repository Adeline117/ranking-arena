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

export const RAW_BUCKET = 'raw-snapshots'

let storageClient: SupabaseClient | null = null

const RAW_UPLOAD_ATTEMPTS = 3
const RAW_UPLOAD_RETRY_BASE_MS = 750
const RAW_GC_ADVISORY_LOCK = "pg_catalog.hashtextextended('arena.raw_object_gc_queue', 0)"

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
}

export interface RawObjectReceipt {
  id: number
  storagePath: string
  contentHash: string
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
): void {
  if (!isRecord(meta) || !Object.hasOwn(meta, 'raw_integrity')) return

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
}

/** Write one raw payload; returns its durable pointer and computed content identity. */
export async function writeRawObject(input: WriteRawInput): Promise<RawObjectReceipt> {
  const json = JSON.stringify(input.payload)
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

  verifyRawIntegrityMetadata(
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

  try {
    return JSON.parse(json)
  } catch {
    throw rawIntegrityError(rawObjectId, pointer.storage_path, 'payload is not valid JSON')
  }
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
