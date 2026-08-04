#!/usr/bin/env node
/**
 * Restore a complete arena+public R2 backup into a target PostgreSQL database.
 *
 * This command is deliberately fail-closed: the remote object and downloaded
 * gzip must satisfy the same completeness contract as the producer, both
 * sides of gunzip|psql must succeed, and critical restored tables must contain
 * positive finite row counts before the command reports DONE.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { config } from 'dotenv'
import {
  inferSupabaseProjectRef,
  PRODUCTION_PROJECT_REF,
} from '../attest-production-types-source.mjs'
import {
  assertBackupArtifact,
  assertCompleteBackupObject,
  COMPLETE_BACKUP_MIN_BYTES,
  arenaCompletionTokenFromMetadata,
  preparePostgresConnection,
} from './backup-restore-contract.mjs'
import { cleanPostgresConnectionEnv } from './postgres-cli-env.mjs'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

export const CRITICAL_RESTORE_TABLES = Object.freeze([
  'arena.traders',
  'arena.trader_stats',
  'public.leaderboard_ranks',
])

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n
const DEFAULT_PSQL_PATH = '/opt/homebrew/opt/postgresql@17/bin/psql'
const DEFAULT_GUNZIP_PATH = '/usr/bin/gunzip'

function postgresChildEnv(password) {
  const childEnv = cleanPostgresConnectionEnv(
    process.env,
    password === undefined ? {} : { PGPASSWORD: password }
  )
  for (const secretName of [
    'DATABASE_URL',
    'RESTORE_TARGET_URL',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ]) {
    delete childEnv[secretName]
  }
  return childEnv
}

export function parseRestoreArgs(argv) {
  const parsed = { allowUnverifiedTarget: false, forceProd: false, key: null, listOnly: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') {
      parsed.listOnly = true
    } else if (arg === '--allow-unverified-target') {
      parsed.allowUnverifiedTarget = true
    } else if (arg === '--force-prod') {
      parsed.forceProd = true
    } else if (arg === '--key') {
      const key = argv[index + 1]
      if (!key || key.startsWith('--')) {
        throw new Error('--key requires an R2 object key')
      }
      if (parsed.key !== null) {
        throw new Error('--key may only be specified once')
      }
      parsed.key = key
      index += 1
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (parsed.listOnly && parsed.key !== null) {
    throw new Error('--list and --key cannot be used together')
  }

  return parsed
}

function decodeIdentityPart(value, label) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error(`${label} has invalid percent-encoding`)
  }
}

function lastQueryValue(url, name) {
  const values = url.searchParams.getAll(name)
  return values.length > 0 ? values.at(-1) : undefined
}

function normalizeHost(host, label) {
  if (!host || host.includes(',')) {
    throw new Error(`${label} must identify exactly one PostgreSQL host`)
  }

  const lower = host.toLowerCase()
  const unbracketed = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  if (isIP(unbracketed) === 6) {
    // WHATWG URL canonicalizes equivalent expanded/compressed IPv6 spellings.
    return new URL(`http://[${unbracketed}]/`).hostname.slice(1, -1)
  }
  return lower.startsWith('/') ? lower : lower.replace(/\.+$/, '')
}

function normalizePort(port, label) {
  if (port.includes(',')) {
    throw new Error(`${label} must identify exactly one PostgreSQL port`)
  }
  if (!/^\d+$/.test(port)) {
    throw new Error(`${label} has an invalid PostgreSQL port`)
  }
  const numericPort = Number(port)
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new Error(`${label} has an invalid PostgreSQL port`)
  }
  return String(numericPort)
}

/**
 * Reduce a libpq URI to the fields that identify its database endpoint. Query
 * overrides are included. Indirect service/hostaddr routing is rejected because
 * it cannot be compared safely with DATABASE_URL.
 */
export function normalizePostgresIdentity(databaseUrl, label) {
  const { connectionUrl } = preparePostgresConnection(databaseUrl, label)
  const parsed = new URL(connectionUrl)

  for (const unsafeParameter of ['hostaddr', 'service', 'servicefile']) {
    if (parsed.searchParams.has(unsafeParameter)) {
      throw new Error(`${label} parameter ${unsafeParameter} is unsupported for restore safety`)
    }
  }

  const rawHost = lastQueryValue(parsed, 'host') ?? parsed.hostname
  const rawPort = lastQueryValue(parsed, 'port') ?? (parsed.port || '5432')
  const rawUser = lastQueryValue(parsed, 'user') ?? decodeIdentityPart(parsed.username, label)
  const pathDatabase = decodeIdentityPart(parsed.pathname.replace(/^\/+/, ''), label)
  const rawDatabase = lastQueryValue(parsed, 'dbname') ?? pathDatabase

  if (!rawUser) {
    throw new Error(`${label} must include an explicit PostgreSQL user`)
  }
  if (!rawDatabase) {
    throw new Error(`${label} must include an explicit PostgreSQL database`)
  }

  return {
    host: normalizeHost(rawHost, label),
    port: normalizePort(rawPort, label),
    database: rawDatabase,
    user: rawUser,
  }
}

export function isSamePostgresDatabase(left, right) {
  // DNS aliases and pooler/direct endpoint mappings require external topology
  // evidence; this lexical guard intentionally does not guess at either.
  return left.host === right.host && left.port === right.port && left.database === right.database
}

export function isSameSupabaseProject(left, right) {
  const leftProjectRef = inferSupabaseProjectRef({ hostname: left.host, username: left.user })
  const rightProjectRef = inferSupabaseProjectRef({ hostname: right.host, username: right.user })
  return leftProjectRef !== null && leftProjectRef === rightProjectRef
}

export function assertRestoreTargetSafety({
  targetIdentity,
  productionIdentity,
  forceProd,
  allowUnverifiedTarget,
}) {
  const targetProjectRef = inferSupabaseProjectRef({
    hostname: targetIdentity.host,
    username: targetIdentity.user,
  })
  if (targetProjectRef === PRODUCTION_PROJECT_REF && !forceProd) {
    throw new Error(
      'REFUSING: RESTORE_TARGET_URL identifies the production database or Supabase project. Pass --force-prod only for an explicitly approved production restore.'
    )
  }

  if (!productionIdentity) {
    if (!allowUnverifiedTarget) {
      throw new Error(
        'DATABASE_URL production identity is unavailable. Pass --allow-unverified-target only after independently proving the restore target is isolated.'
      )
    }
    return
  }

  const targetsProduction =
    isSamePostgresDatabase(targetIdentity, productionIdentity) ||
    isSameSupabaseProject(targetIdentity, productionIdentity)
  if (targetsProduction && !forceProd) {
    throw new Error(
      'REFUSING: RESTORE_TARGET_URL identifies the production database or Supabase project. Pass --force-prod only for an explicitly approved production restore.'
    )
  }
}

export function formatTargetIdentity(identity) {
  return `${identity.user}@${identity.host}:${identity.port}/${identity.database}`
}

export function assertRestorableObject(object, minimumBytes = COMPLETE_BACKUP_MIN_BYTES) {
  return assertCompleteBackupObject(object, minimumBytes)
}

export async function listBackups(s3, bucket) {
  const backups = []
  let continuationToken

  do {
    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'db-backups/',
        ContinuationToken: continuationToken,
      })
    )
    backups.push(...(out.Contents ?? []).filter((object) => object.Key?.endsWith('.sql.gz')))
    continuationToken = out.NextContinuationToken
  } while (continuationToken)

  return backups.sort((left, right) => {
    const leftTime = left.LastModified?.getTime?.() ?? 0
    const rightTime = right.LastModified?.getTime?.() ?? 0
    return rightTime - leftTime || String(right.Key).localeCompare(String(left.Key))
  })
}

/** Resolve an explicit key independently from the paginated list result. */
export async function headBackup(s3, bucket, key) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    Key: key,
    Size: head.ContentLength,
    LastModified: head.LastModified,
    ETag: head.ETag,
    Metadata: head.Metadata,
  }
}

/** Both default and explicit selection are resolved through authoritative HEAD metadata. */
export async function selectBackup(s3, bucket, key) {
  if (key) return headBackup(s3, bucket, key)

  const newest = (await listBackups(s3, bucket))[0]
  return newest ? headBackup(s3, bucket, newest.Key) : undefined
}

/** Download only the exact object revision and size selected for restore. */
export async function downloadBackupObject({ s3, bucket, selected, localPath, minimumBytes }) {
  assertRestorableObject(selected, minimumBytes)
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: selected.Key,
      ...(selected.ETag ? { IfMatch: selected.ETag } : {}),
    })
  )

  const abortBody = () => response.Body?.destroy?.()
  if (!response.Body) {
    throw new Error('selected backup object returned no body')
  }
  try {
    assertRestorableObject(
      {
        ...selected,
        Size: response.ContentLength,
        ETag: response.ETag,
        Metadata: response.Metadata,
      },
      minimumBytes
    )
  } catch (error) {
    abortBody()
    throw new Error(`downloaded backup response failed completeness checks: ${error.message}`)
  }
  if (response.ETag !== selected.ETag) {
    abortBody()
    throw new Error(`downloaded backup ETag changed after selection: ${response.ETag}`)
  }
  if (
    arenaCompletionTokenFromMetadata(response.Metadata) !==
    arenaCompletionTokenFromMetadata(selected.Metadata)
  ) {
    abortBody()
    throw new Error('downloaded backup completion token changed after selection')
  }
  if (response.ContentLength !== selected.Size) {
    abortBody()
    throw new Error(
      `downloaded backup size changed after selection: ${response.ContentLength} != ${selected.Size}`
    )
  }

  await pipeline(response.Body, createWriteStream(localPath, { flags: 'wx' }))
}

/** Apply a plain-SQL gzip and preserve both gunzip and psql exit status. */
export function runRestorePipeline({
  localGz,
  gunzipPath,
  psqlPath,
  connectionUrl,
  password,
  timeoutMs = 2 * 60 * 60_000,
}) {
  const postgresEnv = postgresChildEnv(password)

  execFileSync(
    '/bin/bash',
    [
      '-o',
      'pipefail',
      '-c',
      '"$2" -c "$1" | "$3" -X --no-password -v ON_ERROR_STOP=1 --single-transaction --quiet "$4"',
      'arena-restore-pipeline',
      localGz,
      gunzipPath,
      psqlPath,
      connectionUrl,
    ],
    {
      env: postgresEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: timeoutMs,
    }
  )
}

const CRITICAL_COUNT_SQL = CRITICAL_RESTORE_TABLES.map(
  (table) => `SELECT '${table}', count(*)::text FROM ${table}`
).join(' UNION ALL ')

export function queryCriticalTableCounts({
  psqlPath,
  connectionUrl,
  password,
  timeoutMs = 5 * 60_000,
}) {
  const postgresEnv = postgresChildEnv(password)
  return execFileSync(
    psqlPath,
    [
      '-X',
      '--no-password',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
      '-F',
      '\t',
      '-c',
      CRITICAL_COUNT_SQL,
      connectionUrl,
    ],
    {
      encoding: 'utf8',
      env: postgresEnv,
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: timeoutMs,
    }
  )
}

export function parseCriticalTableCounts(output) {
  const counts = new Map()
  const lines = output.trim() === '' ? [] : output.trim().split(/\r?\n/)

  for (const line of lines) {
    const fields = line.split('\t')
    if (fields.length !== 2 || !CRITICAL_RESTORE_TABLES.includes(fields[0])) {
      throw new Error(`restore verification returned an unexpected row: ${line}`)
    }
    if (counts.has(fields[0])) {
      throw new Error(`restore verification returned duplicate count for ${fields[0]}`)
    }
    if (!/^(0|[1-9]\d*)$/.test(fields[1])) {
      throw new Error(`restore verification returned a non-finite count for ${fields[0]}`)
    }

    const count = BigInt(fields[1])
    if (count < 1n || count > POSTGRES_BIGINT_MAX) {
      throw new Error(`restore verification requires ${fields[0]} to contain rows`)
    }
    counts.set(fields[0], count)
  }

  for (const table of CRITICAL_RESTORE_TABLES) {
    if (!counts.has(table)) {
      throw new Error(`restore verification is missing ${table}`)
    }
  }

  return Object.fromEntries(CRITICAL_RESTORE_TABLES.map((table) => [table, counts.get(table)]))
}

/**
 * Execute the exact production restore gates in order. Dependencies are
 * injected only so tests can exercise the orchestration without R2 or a DB.
 */
export async function restoreSelectedBackup({
  selected,
  localPath,
  minimumBytes = COMPLETE_BACKUP_MIN_BYTES,
  download,
  apply,
  verify,
}) {
  assertRestorableObject(selected, minimumBytes)
  await download(localPath)

  const completionToken = arenaCompletionTokenFromMetadata(selected.Metadata)
  const downloadedSize = await assertBackupArtifact(localPath, minimumBytes, { completionToken })
  if (downloadedSize !== selected.Size) {
    throw new Error(
      `downloaded backup size does not match selected object: ${downloadedSize} != ${selected.Size}`
    )
  }

  await apply(localPath)
  return parseCriticalTableCounts(await verify())
}

export async function runRestoreCli({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseRestoreArgs(argv)
  const accountId = env.R2_ACCOUNT_ID
  const accessKeyId = env.R2_ACCESS_KEY_ID
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY
  const bucket = env.R2_BUCKET || 'arena-backups'

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)'
    )
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })

  if (args.listOnly) {
    const backups = await listBackups(s3, bucket)
    if (backups.length === 0) {
      throw new Error('No .sql.gz backups found in R2 — backup pipeline may be broken')
    }
    console.log(`[restore] ${backups.length} backups (newest first):`)
    for (const backup of backups.slice(0, 20)) {
      const size = Number.isSafeInteger(backup.Size)
        ? `${(backup.Size / 1e6).toFixed(1)}MB`
        : 'unknown'
      const modified = backup.LastModified?.toISOString?.() ?? 'unknown-time'
      console.log(`  ${backup.Key}  ${size}  ${modified}`)
    }
    return
  }

  const target = env.RESTORE_TARGET_URL
  if (!target) {
    throw new Error('RESTORE_TARGET_URL not set. Refusing to guess a target.')
  }

  const preparedTarget = preparePostgresConnection(target, 'RESTORE_TARGET_URL')
  const targetIdentity = normalizePostgresIdentity(target, 'RESTORE_TARGET_URL')
  const productionIdentity = env.DATABASE_URL
    ? normalizePostgresIdentity(env.DATABASE_URL, 'DATABASE_URL')
    : null
  // A different role can still overwrite the same database. User remains in
  // the normalized identity for audit logs, but is not a production bypass.
  assertRestoreTargetSafety({
    targetIdentity,
    productionIdentity,
    forceProd: args.forceProd,
    allowUnverifiedTarget: args.allowUnverifiedTarget,
  })

  const selected = await selectBackup(s3, bucket, args.key)
  if (!selected) {
    throw new Error('No .sql.gz backups found in R2 — backup pipeline may be broken')
  }
  assertRestorableObject(selected)

  console.log(`[restore] Source: ${bucket}/${selected.Key} (${selected.Size} bytes)`)
  console.log(`[restore] Target: ${formatTargetIdentity(targetIdentity)}`)

  const restoreDirectory = await mkdtemp(join(tmpdir(), 'arena-restore-'))
  const localGz = join(restoreDirectory, 'backup.sql.gz')
  const psqlPath = env.PSQL_PATH || DEFAULT_PSQL_PATH
  const gunzipPath = env.GUNZIP_PATH || DEFAULT_GUNZIP_PATH

  let counts
  try {
    counts = await restoreSelectedBackup({
      selected,
      localPath: localGz,
      download: () =>
        downloadBackupObject({
          s3,
          bucket,
          selected,
          localPath: localGz,
          minimumBytes: COMPLETE_BACKUP_MIN_BYTES,
        }),
      apply: () =>
        runRestorePipeline({
          localGz,
          gunzipPath,
          psqlPath,
          ...preparedTarget,
        }),
      verify: () =>
        queryCriticalTableCounts({
          psqlPath,
          ...preparedTarget,
        }),
    })
  } finally {
    await rm(restoreDirectory, { force: true, recursive: true })
  }

  console.log('[restore] Verified critical row counts:')
  for (const table of CRITICAL_RESTORE_TABLES) {
    console.log(`  ${table}=${counts[table]}`)
  }
  console.log(
    '[restore] DONE. Re-apply canonical migrations for policies/grants; auth is PITR-only.'
  )
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectRun) {
  runRestoreCli().catch((error) => {
    console.error('[restore] FAILED:', error.message)
    process.exitCode = 1
  })
}
