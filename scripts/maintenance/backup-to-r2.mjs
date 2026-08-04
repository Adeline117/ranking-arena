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
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'url'
import {
  HeadObjectCommand,
  S3Client,
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
  parseCompleteBackupKey,
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
export const DELETE_OBJECTS_BATCH_SIZE = 1000

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
  body,
  localPath,
  size,
  metadata,
  UploadClass = Upload,
}) {
  const uploaded = await uploadBackupArtifact({
    client,
    bucket,
    key,
    body,
    localPath,
    size,
    metadata,
    UploadClass,
  })
  return attestUploadedBackupArtifact({
    client,
    bucket,
    key,
    size,
    metadata,
    uploadETag: uploaded.ETag,
  })
}

export async function uploadBackupArtifact({
  client,
  bucket,
  key,
  body,
  localPath,
  size,
  metadata,
  UploadClass = Upload,
}) {
  if (!body && !localPath) {
    throw new Error('multipart upload requires a sealed body or local path')
  }
  const uploader = new UploadClass({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body ?? createReadStream(localPath),
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
  return uploaded
}

export async function attestUploadedBackupArtifact({
  client,
  bucket,
  key,
  size,
  metadata,
  uploadETag,
}) {
  const head = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
      IfMatch: uploadETag,
    })
  )
  return assertUploadedBackupObject({
    key,
    expectedSize: size,
    expectedMetadata: metadata,
    uploadETag,
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

  const outputFd = openExclusiveRegularFile(outputPath)
  try {
    execFileSync(
      '/bin/bash',
      [
        '-o',
        'pipefail',
        '-c',
        'sentinel=$1; shift; { "$@" && printf "%s" "$sentinel"; } | /usr/bin/gzip -c',
        'arena-backup-pipeline',
        completionSentinel,
        pgDumpPath,
        ...pgDumpArgs,
        `--restrict-key=${completionToken}`,
        connectionUrl,
      ],
      {
        env: pgDumpEnv,
        stdio: ['ignore', outputFd, 'pipe'],
        timeout: timeoutMs,
      }
    )
  } finally {
    closeSync(outputFd)
  }
}

function openExclusiveRegularFile(path) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const fd = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow
  return openSync(path, fd, 0o600)
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function readSealedFileState(fd, localPath, expected) {
  const descriptor = fstatSync(fd, { bigint: true })
  const pathname = lstatSync(localPath, { bigint: true })
  if (!descriptor.isFile() || !pathname.isFile() || descriptor.nlink !== 1n) {
    throw new Error('backup artifact must be one exclusively owned regular file')
  }
  if (!sameFileIdentity(descriptor, pathname)) {
    throw new Error('backup artifact pathname identity changed')
  }
  if (expected && !sameFileIdentity(descriptor, expected)) {
    throw new Error('sealed backup artifact changed after validation')
  }
  return descriptor
}

async function sha256FileDescriptor(fd, size) {
  const hash = createHash('sha256')
  const stream = createReadStream('', {
    fd,
    autoClose: false,
    start: 0,
    end: size - 1,
  })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export function createBackupWorkspace(filename) {
  if (basename(filename) !== filename || !IMMUTABLE_BACKUP_FILENAME_PATTERN.test(filename)) {
    throw new Error('backup filename is invalid')
  }
  const directory = mkdtempSync(join(tmpdir(), 'arena-backup-'))
  try {
    // mkdtemp already requests owner-only access. Enforce the exact contract in
    // case the process umask is unusually restrictive or the platform changes.
    chmodSync(directory, 0o700)
  } catch (error) {
    rmdirSync(directory)
    throw error
  }
  return { directory, localPath: join(directory, filename) }
}

export function cleanupBackupWorkspace({ directory, localPath }) {
  if (
    typeof directory !== 'string' ||
    typeof localPath !== 'string' ||
    dirname(directory) !== tmpdir() ||
    !basename(directory).startsWith('arena-backup-') ||
    dirname(localPath) !== directory ||
    !IMMUTABLE_BACKUP_FILENAME_PATTERN.test(basename(localPath))
  ) {
    throw new Error('refusing to clean an invalid backup workspace')
  }
  // Never recursively remove a pathname assembled from external state. The
  // workspace has exactly one owned artifact; an unexpected extra entry makes
  // rmdir fail closed instead of deleting unrelated data.
  rmSync(localPath, { force: true })
  try {
    rmdirSync(directory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function installBackupWorkspaceSignalCleanup(workspace) {
  const handlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      try {
        cleanupBackupWorkspace(workspace)
      } catch (error) {
        console.error(`[backup] Workspace cleanup failed during ${signal}:`, error.message)
      }
      process.removeListener(signal, handler)
      process.kill(process.pid, signal)
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
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
  verifyUpload,
  prune,
  reportPruneFailure = () => {},
}) {
  await produce()
  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const fd = openSync(localPath, fsConstants.O_RDONLY | noFollow)
  let body
  try {
    const sealedState = readSealedFileState(fd, localPath)
    const size = await assertBackupArtifact(localPath, minimumBytes, { completionToken })
    if (sealedState.size !== BigInt(size)) {
      throw new Error('validated backup size disagrees with sealed file')
    }
    readSealedFileState(fd, localPath, sealedState)
    const sha256 = await sha256FileDescriptor(fd, size)
    readSealedFileState(fd, localPath, sealedState)

    body = createReadStream('', {
      fd,
      autoClose: false,
      start: 0,
      end: size - 1,
    })
    const evidence = Object.freeze({ size, sha256, body })
    const uploadResult = await upload(evidence)
    if (!body.readableEnded) {
      throw new Error('backup upload returned before consuming the sealed artifact')
    }
    readSealedFileState(fd, localPath, sealedState)
    if (typeof verifyUpload !== 'function') {
      throw new Error('post-upload HEAD verification is required')
    }
    await verifyUpload(evidence, uploadResult)
    readSealedFileState(fd, localPath, sealedState)
    unlinkSync(localPath)
    try {
      await prune()
    } catch (error) {
      // Retention is best-effort after an immutable object has been uploaded
      // and authoritatively attested. It must not turn a successful backup into
      // a false failure signal.
      try {
        await reportPruneFailure(error)
      } catch {
        // Reporting a secondary retention error is also non-authoritative.
      }
    }
    return size
  } finally {
    if (body && !body.destroyed && !body.readableEnded) body.destroy()
    try {
      closeSync(fd)
    } catch (error) {
      if (error?.code !== 'EBADF') throw error
    }
  }
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
  const { filename, r2Key } = identity
  const workspace = createBackupWorkspace(filename)
  const { localPath } = workspace
  const removeSignalCleanup = installBackupWorkspaceSignalCleanup(workspace)

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
    const baseMetadata = buildBackupMetadata({ now, mode, completionToken })
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
      upload: async ({ size, sha256, body }) => {
        const sizeMB = (size / 1024 / 1024).toFixed(1)
        console.log(`[backup] Dump complete: ${sizeMB} MB`)
        console.log(`[backup] Uploading to R2: ${R2_BUCKET}/${r2Key}`)
        const metadata = {
          ...baseMetadata,
          'artifact-size': String(size),
          'artifact-sha256': sha256,
        }
        const uploaded = await uploadBackupArtifact({
          client: s3,
          bucket: R2_BUCKET,
          key: r2Key,
          body,
          size,
          metadata,
        })
        return { metadata, uploadETag: uploaded.ETag, sizeMB }
      },
      verifyUpload: async ({ size }, { metadata, uploadETag, sizeMB }) => {
        const remote = await attestUploadedBackupArtifact({
          client: s3,
          bucket: R2_BUCKET,
          key: r2Key,
          size,
          metadata,
          uploadETag,
        })
        console.log(
          `[backup] ✓ Uploaded and attested: ${r2Key} (${sizeMB} MB, ETag ${remote.ETag})`
        )
      },
      prune: () => pruneOldBackups(),
      reportPruneFailure: (error) =>
        console.error('[backup] Retention prune failed (backup itself succeeded):', error.message),
    })
  } catch (err) {
    console.error(`[backup] ✗ Failed:`, err.message)
    process.exitCode = 1
  } finally {
    removeSignalCleanup()
    cleanupBackupWorkspace(workspace)
  }
}

/**
 * Delete only immutable artifacts whose current HEAD metadata satisfies the
 * complete-backup contract. List results are inventory hints, never deletion
 * authority; invalid or unavailable objects neither consume full-backup slots
 * nor become deletion candidates.
 */
export async function pruneOldBackups({
  client = s3,
  bucket = R2_BUCKET,
  now = new Date(),
  minimumBytes = COMPLETE_BACKUP_MIN_BYTES,
  logger = console,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('retention timestamp is invalid')
  }

  let token
  const seenTokens = new Set()
  const listed = []
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'db-backups/',
        ...(token ? { ContinuationToken: token } : {}),
      })
    )
    listed.push(...(page.Contents ?? []))

    const next = page.NextContinuationToken
    if (page.IsTruncated && !next) {
      throw new Error('retention inventory was truncated without a continuation token')
    }
    if (next && seenTokens.has(next)) {
      throw new Error('retention inventory repeated a continuation token')
    }
    if (next) seenTokens.add(next)
    token = next
  } while (token)

  const verified = []
  const seenKeys = new Set()
  for (const listedObject of listed) {
    const identity = parseCompleteBackupKey(listedObject?.Key)
    if (!identity || identity.format !== 'immutable' || seenKeys.has(listedObject.Key)) continue
    seenKeys.add(listedObject.Key)

    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: listedObject.Key })
      )
      if (head.ContentType !== 'application/gzip') {
        throw new Error('backup object content type is not application/gzip')
      }
      const object = assertCompleteBackupObject(
        {
          Key: listedObject.Key,
          Size: head.ContentLength,
          ETag: head.ETag,
          Metadata: head.Metadata,
        },
        minimumBytes
      )
      verified.push({ ...object, identity })
    } catch (error) {
      logger.warn?.(
        `[backup] Retention skipped unverified object ${String(listedObject?.Key)}: ${error.message}`
      )
    }
  }

  const cutoff = new Date(now.getTime() - DAILY_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const keepFulls = new Set(
    verified
      .filter(({ identity }) => identity.mode === 'full')
      .sort(
        (left, right) =>
          right.identity.timestamp.localeCompare(left.identity.timestamp) ||
          right.Key.localeCompare(left.Key)
      )
      .slice(0, FULL_BACKUPS_TO_KEEP)
      .map(({ Key }) => Key)
  )
  const toDelete = verified.filter(({ Key, identity }) =>
    identity.mode === 'full' ? !keepFulls.has(Key) : identity.date < cutoff
  )

  if (toDelete.length === 0) {
    logger.log?.('[backup] Retention: nothing to prune')
    return { deleted: 0, errors: [], verified: verified.length }
  }

  const errors = []
  let deleted = 0
  for (let offset = 0; offset < toDelete.length; offset += DELETE_OBJECTS_BATCH_SIZE) {
    const batch = toDelete.slice(offset, offset + DELETE_OBJECTS_BATCH_SIZE)
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map(({ Key }) => ({ Key })) },
      })
    )
    deleted += response.Deleted?.length ?? 0
    errors.push(...(response.Errors ?? []))
  }

  const freedMB = (toDelete.reduce((sum, object) => sum + object.Size, 0) / 1048576).toFixed(0)
  logger.log?.(
    `[backup] Retention: requested ${toDelete.length}, deleted ${deleted} objects (${freedMB} MB)` +
      (errors.length
        ? `, ${errors.length} errors: ${errors.map((error) => error.Key).join(', ')}`
        : '')
  )
  return { deleted, errors, verified: verified.length }
}

const isDirectRun =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isDirectRun) {
  run()
}
