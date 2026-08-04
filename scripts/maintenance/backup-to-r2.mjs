#!/usr/bin/env node

/**
 * Long-term database backup to Cloudflare R2
 *
 * Dumps an explicit application schema set or the full database → gzip → upload to R2
 * Run the application-data capture: BACKUP_SCHEMAS=arena,public npm run backup:r2
 * Run a full-database capture: npm run backup:r2:full
 * Neither mode is a proven managed-auth disaster-recovery path until its
 * matching restore drill has passed on an isolated managed scratch project.
 *
 * Requires: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { execFileSync } from 'child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, unlinkSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import 'dotenv/config'
import {
  assertBackupArtifact,
  assertCompleteBackupObject,
  ARENA_BACKUP_COMPLETION_CONTRACT,
  arenaBackupCompletionSentinel,
  COMPLETE_BACKUP_MIN_BYTES,
  IMMUTABLE_BACKUP_FILENAME_PATTERN,
  parseCompleteBackupFilename,
  preparePostgresConnection,
  unverifiedBackupRecoveryMetadata,
} from './backup-restore-contract.mjs'
import { cleanPostgresConnectionEnv } from './postgres-cli-env.mjs'

export { assertBackupArtifact, COMPLETE_BACKUP_MIN_BYTES, IMMUTABLE_BACKUP_FILENAME_PATTERN }

// Retention: daily schema backups are kept this many days; full backups keep
// the N newest regardless of age.
const DAILY_RETENTION_DAYS = 14
const FULL_BACKUPS_TO_KEEP = 3
export const MULTIPART_PART_SIZE_BYTES = 64 * 1024 * 1024
export const MULTIPART_QUEUE_SIZE = 4

const DATABASE_URL = process.env.DATABASE_URL
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-backups'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

// Schema 模式：BACKUP_SCHEMAS=arena,public → dump 这些 schema 全部（含主数据层
// arena.*）。GH Actions 备份用此模式抓完整 app 数据，跳过
// storage.objects(2.2GB 文件元数据，实体在 Supabase Storage)/auth 系统 schema。

export function normalizeCompleteBackupSchemas(value) {
  const schemas = [
    ...new Set(
      String(value ?? '')
        .split(',')
        .map((schema) => schema.trim())
        .filter(Boolean)
    ),
  ]
  if (schemas.length > 0 && (!schemas.includes('arena') || !schemas.includes('public'))) {
    throw new Error('BACKUP_SCHEMAS complete mode requires both arena and public')
  }
  if (schemas.some((schema) => schema !== 'arena' && schema !== 'public')) {
    throw new Error(
      'current plain schema backup supports exactly arena,public; managed or extra schemas require a separately verified recovery contract'
    )
  }
  return schemas
}

/**
 * Resolve exactly one complete backup mode. The old implicit public-table mode
 * was incomplete after the authority data moved into arena.*, so absence of an
 * explicit complete mode must stop before pg_dump or R2 side effects.
 */
export function parseBackupMode({ argv = [], schemasEnv = '' } = {}) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw new Error('backup arguments must be a string array')
  }

  const unknownArgs = argv.filter((arg) => arg !== '--full')
  if (unknownArgs.length > 0) {
    throw new Error('unknown backup argument')
  }
  if (argv.filter((arg) => arg === '--full').length > 1) {
    throw new Error('--full may only be specified once')
  }

  const schemas = normalizeCompleteBackupSchemas(schemasEnv)
  const full = argv.includes('--full')
  if (full && schemas.length > 0) {
    throw new Error('--full and BACKUP_SCHEMAS are mutually exclusive')
  }
  if (full) return { type: 'full', schemas: [] }
  if (schemas.length > 0) return { type: 'schemas', schemas }

  throw new Error('refusing incomplete backup: set BACKUP_SCHEMAS or pass --full')
}

const BACKUP_RUN_ID_PATTERN = /^[0-9a-f]{32}$/
const LEGACY_BACKUP_FILENAME_PATTERN = /^arena-backup-(\d{8})(?:-(?:schemas|full))?\.sql\.gz$/

/** Build one immutable local/R2 artifact identity without reading credentials. */
export function buildBackupArtifactIdentity({ now, mode, runId }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('backup timestamp is invalid')
  }
  if (mode?.type !== 'schemas' && mode?.type !== 'full') {
    throw new Error('backup mode is invalid')
  }
  if (!BACKUP_RUN_ID_PATTERN.test(runId)) {
    throw new Error('backup run id is invalid')
  }

  const isoTimestamp = now.toISOString()
  const compactTimestamp = isoTimestamp.replace(/[-:.]/g, '')
  const filename = `arena-backup-${compactTimestamp}-${runId}-${mode.type}.sql.gz`
  return {
    filename,
    localPath: `/tmp/${filename}`,
    r2Key: `db-backups/${isoTimestamp.slice(0, 4)}/${isoTimestamp.slice(5, 7)}/${filename}`,
  }
}

export function backupDateFromKey(key) {
  if (typeof key !== 'string') return ''
  const filename = key.split('/').at(-1)
  const completeIdentity = parseCompleteBackupFilename(filename)
  if (completeIdentity) return completeIdentity.date
  return filename.match(LEGACY_BACKUP_FILENAME_PATTERN)?.[1] ?? ''
}

export function buildBackupMetadata({ now, mode, completionToken }) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('backup metadata timestamp is invalid')
  }
  if (mode?.type !== 'schemas' && mode?.type !== 'full') {
    throw new Error('backup metadata mode is invalid')
  }
  arenaBackupCompletionSentinel(completionToken)

  let schemas = []
  if (mode.type === 'schemas') {
    if (!Array.isArray(mode.schemas)) throw new Error('backup metadata schemas are invalid')
    schemas = normalizeCompleteBackupSchemas(mode.schemas.join(','))
    if (schemas.length === 0) throw new Error('backup metadata schemas are invalid')
  } else if (Array.isArray(mode.schemas) && mode.schemas.length > 0) {
    throw new Error('full backup metadata cannot include schema selection')
  }
  return {
    'backup-date': now.toISOString(),
    'backup-type': mode.type === 'schemas' ? `schemas:${schemas.join('+')}` : 'full',
    tables: mode.type === 'schemas' ? schemas.join(',') : 'all',
    'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
    'completion-token': completionToken,
    ...unverifiedBackupRecoveryMetadata(mode.type),
  }
}

function normalizeETag(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  return value.trim().replace(/^"|"$/g, '')
}

export function assertUploadedBackupObject({
  key,
  expectedSize,
  expectedMetadata,
  uploadETag,
  head,
}) {
  const object = assertCompleteBackupObject({
    Key: key,
    Size: head?.ContentLength,
    ETag: head?.ETag,
    Metadata: head?.Metadata,
  })

  if (object.Size !== expectedSize) {
    throw new Error(
      `uploaded backup size attestation failed: expected ${expectedSize}, received ${String(object.Size)}`
    )
  }
  if (head.ContentType !== 'application/gzip') {
    throw new Error('uploaded backup content type attestation failed')
  }
  if (!normalizeETag(uploadETag) || normalizeETag(uploadETag) !== normalizeETag(object.ETag)) {
    throw new Error('uploaded backup ETag attestation failed')
  }

  const normalizedRemoteMetadata = Object.fromEntries(
    Object.entries(head.Metadata ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      String(value).trim(),
    ])
  )
  for (const [name, value] of Object.entries(expectedMetadata)) {
    if (normalizedRemoteMetadata[name.toLowerCase()] !== value) {
      throw new Error(`uploaded backup metadata attestation failed: ${name}`)
    }
  }

  return object
}

export async function uploadAndAttestBackupArtifact({
  client,
  bucket,
  key,
  localPath,
  size,
  metadata,
  UploadClass = Upload,
}) {
  const uploader = new UploadClass({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: 'application/gzip',
      ContentLength: size,
      Metadata: metadata,
    },
    queueSize: MULTIPART_QUEUE_SIZE,
    partSize: MULTIPART_PART_SIZE_BYTES,
    leavePartsOnError: false,
  })
  const uploaded = await uploader.done()
  if (!normalizeETag(uploaded?.ETag)) {
    throw new Error('multipart upload did not return an ETag identity')
  }

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: uploaded.ETag,
    })
  )
  return assertUploadedBackupObject({
    key,
    expectedSize: size,
    expectedMetadata: metadata,
    uploadETag: uploaded.ETag,
    head,
  })
}

/**
 * Keep database credentials out of pg_dump's argv. libpq accepts the password
 * through PGPASSWORD, while the remaining URI (including SSL/query settings)
 * stays as the database argument.
 */
export function preparePgDumpConnection(databaseUrl) {
  return preparePostgresConnection(databaseUrl, 'DATABASE_URL')
}

/**
 * Stream pg_dump through gzip while preserving both programs' exit status.
 *
 * Bash receives every dynamic value as a positional argument, so database
 * URLs, paths, schemas, and tables are never interpolated into shell source.
 * `pipefail` is essential: without it a failed pg_dump followed by a successful
 * gzip produces a valid 20-byte empty gzip and the backup falsely succeeds.
 */
export function runPgDumpPipeline({
  pgDumpPath,
  connectionUrl,
  password,
  pgDumpArgs,
  outputPath,
  completionToken,
  timeoutMs = 1_800_000,
}) {
  const pgDumpEnv = cleanPostgresConnectionEnv(
    process.env,
    password === undefined ? {} : { PGPASSWORD: password }
  )
  for (const name of [
    'DATABASE_URL',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
  ]) {
    delete pgDumpEnv[name]
  }
  const completionSentinel = arenaBackupCompletionSentinel(completionToken)

  execFileSync(
    '/bin/bash',
    [
      '-o',
      'pipefail',
      '-c',
      'output=$1; sentinel=$2; shift 2; { "$@" && printf "%s" "$sentinel"; } | /usr/bin/gzip -c > "$output"',
      'arena-backup-pipeline',
      outputPath,
      completionSentinel,
      pgDumpPath,
      ...pgDumpArgs,
      `--restrict-key=${completionToken}`,
      connectionUrl,
    ],
    {
      env: pgDumpEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }
  )
}

/**
 * Keep production side effects behind a validated local artifact. Injection is
 * deliberate: tests execute the real producer and prove rejected artifacts
 * cannot reach either the upload or retention boundary.
 */
export async function produceAndCommitBackup({
  produce,
  localPath,
  minimumBytes,
  completionToken,
  upload,
  prune,
}) {
  await produce()
  const size = await assertBackupArtifact(localPath, minimumBytes, { completionToken })
  await upload(size)
  unlinkSync(localPath)
  await prune()
  return size
}

async function run() {
  let mode
  try {
    mode = parseBackupMode({
      argv: process.argv.slice(2),
      schemasEnv: process.env.BACKUP_SCHEMAS,
    })
  } catch (err) {
    console.error('[backup] Refusing to start:', err.message)
    process.exit(1)
  }

  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL')
    process.exit(1)
  }
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
    process.exit(1)
  }

  const now = new Date()
  const identity = buildBackupArtifactIdentity({
    now,
    mode,
    runId: randomBytes(16).toString('hex'),
  })
  const schemaMode = mode.type === 'schemas'
  const backupSchemas = mode.schemas
  const modeLabel = schemaMode ? `schemas [${backupSchemas.join(',')}]` : 'FULL'
  console.log(`[backup] Starting ${modeLabel} backup — ${now.toISOString()}`)

  const selectionArgs = schemaMode ? backupSchemas.flatMap((s) => ['-n', s]) : [] // full mode dumps everything
  const { localPath, r2Key } = identity

  try {
    // pg_dump → gzip (PostgreSQL 17 匹配 Supabase 服务器)
    // 路径可 env 覆盖：Mac 本机默认 Homebrew pg17；GH Actions 装 client 后设 PG_DUMP_PATH=pg_dump
    const pgDumpPath = process.env.PG_DUMP_PATH || '/opt/homebrew/opt/postgresql@17/bin/pg_dump'
    console.log(
      `[backup] Dumping ${schemaMode ? backupSchemas.join('+') + ' schemas' : 'full database'}...`
    )
    // Complete dumps over the network can take 15-20min. A 30min producer
    // budget prevents false ETIMEDOUT.
    const { connectionUrl, password } = preparePgDumpConnection(DATABASE_URL)
    const minimumBytes = COMPLETE_BACKUP_MIN_BYTES
    const completionToken = randomBytes(32).toString('hex')
    const metadata = buildBackupMetadata({ now, mode, completionToken })
    await produceAndCommitBackup({
      produce: () =>
        runPgDumpPipeline({
          pgDumpPath,
          connectionUrl,
          password,
          pgDumpArgs: [...selectionArgs, '--no-owner', '--no-privileges'],
          outputPath: localPath,
          completionToken,
        }),
      localPath,
      minimumBytes,
      completionToken,
      upload: async (size) => {
        const sizeMB = (size / 1024 / 1024).toFixed(1)
        console.log(`[backup] Dump complete: ${sizeMB} MB`)
        console.log(`[backup] Uploading to R2: ${R2_BUCKET}/${r2Key}`)
        const remote = await uploadAndAttestBackupArtifact({
          client: s3,
          bucket: R2_BUCKET,
          key: r2Key,
          localPath,
          size,
          metadata,
        })
        console.log(
          `[backup] ✓ Uploaded and attested: ${r2Key} (${sizeMB} MB, ETag ${remote.ETag})`
        )
      },
      prune: pruneOldBackups,
    })
  } catch (err) {
    console.error(`[backup] ✗ Failed:`, err.message)
    try {
      unlinkSync(localPath)
    } catch {}
    process.exit(1)
  }
}

// Prune objects outside retention. Failures here must never fail the backup
// run itself — the upload already succeeded.
async function pruneOldBackups() {
  try {
    let token
    const all = []
    do {
      const r = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          Prefix: 'db-backups/',
          ContinuationToken: token,
        })
      )
      all.push(...(r.Contents || []))
      token = r.NextContinuationToken
    } while (token)

    const isFull = (k) => k.includes('-full')
    const cutoffDate = new Date(Date.now() - DAILY_RETENTION_DAYS * 86_400_000)
    const cutoff = cutoffDate.toISOString().slice(0, 10).replace(/-/g, '')
    const keepFulls = new Set(
      all
        .filter((o) => isFull(o.Key))
        .sort(
          (a, b) =>
            backupDateFromKey(b.Key).localeCompare(backupDateFromKey(a.Key)) ||
            String(b.Key).localeCompare(String(a.Key))
        )
        .slice(0, FULL_BACKUPS_TO_KEEP)
        .map((o) => o.Key)
    )
    const toDelete = all.filter((o) =>
      isFull(o.Key)
        ? !keepFulls.has(o.Key)
        : backupDateFromKey(o.Key) !== '' && backupDateFromKey(o.Key) < cutoff
    )
    if (toDelete.length === 0) {
      console.log('[backup] Retention: nothing to prune')
      return
    }
    const freedMB = (toDelete.reduce((s, o) => s + o.Size, 0) / 1048576).toFixed(0)
    // DeleteObjects caps at 1000 keys per call; retention never approaches that
    const r = await s3.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: toDelete.map((o) => ({ Key: o.Key })) },
      })
    )
    const errs = r.Errors || []
    console.log(
      `[backup] Retention: pruned ${(r.Deleted || []).length} objects (${freedMB} MB)` +
        (errs.length ? `, ${errs.length} errors: ${errs.map((e) => e.Key).join(', ')}` : '')
    )
  } catch (err) {
    console.error('[backup] Retention prune failed (backup itself succeeded):', err.message)
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  run()
}
