#!/usr/bin/env node

/**
 * Long-term database backup to Cloudflare R2
 *
 * Dumps all trader data tables → gzip → upload to R2
 * Run daily via Mac Mini cron: npm run backup:r2
 * Run manually with full DB: npm run backup:r2:full
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
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import 'dotenv/config'
import {
  assertBackupArtifact,
  ARENA_BACKUP_COMPLETION_CONTRACT,
  arenaBackupCompletionSentinel,
  COMPLETE_BACKUP_MIN_BYTES,
  preparePostgresConnection,
} from './backup-restore-contract.mjs'
import { cleanPostgresConnectionEnv } from './postgres-cli-env.mjs'

export { assertBackupArtifact, COMPLETE_BACKUP_MIN_BYTES }

// Retention: daily (trader-tables) backups kept this many days; full backups
// keep the N newest regardless of age (they are the only complete restore points)
const DAILY_RETENTION_DAYS = 14
const FULL_BACKUPS_TO_KEEP = 3

const TRADER_TABLES = [
  // Core trader data
  'trader_equity_curve',
  'trader_snapshots',
  'trader_snapshots_v2',
  'trader_daily_snapshots',
  'trader_timeseries',
  'trader_roi_history',
  // Position data
  'trader_position_history',
  'trader_positions_history',
  'trader_positions_live',
  'trader_position_summary',
  // Asset & trading details
  'trader_asset_breakdown',
  'trader_frequently_traded',
  // Identity & profile
  'trader_sources',
  'trader_sources_v2',
  'traders',
  'trader_profiles_v2',
  'trader_stats_detail',
  'trader_scores',
  'trader_links',
  'trader_portfolio',
  // Flags & quality
  'trader_flags',
  'trader_anomalies',
  'trader_seasons',
  'trader_merges',
  // Social
  'trader_follows',
  'trader_authorizations',
  'trader_alerts',
  // Leaderboard
  'leaderboard_ranks',
  'leaderboard_snapshots',
  'daily_trader_stats',
]

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

const now = new Date()
const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
const fullMode = process.argv.includes('--full')
// Schema 模式：BACKUP_SCHEMAS=arena,public → dump 这些 schema 全部（含主数据层
// arena.*）。默认的 public.* TRADER_TABLES 模式**漏掉了 arena.* 主数据层**
// （数据已迁 arena schema，见 2026-07 发现），GH Actions 备份用此模式抓完整 app 数据，
// 跳过 storage.objects(2.2GB 文件元数据，实体在 Supabase Storage)/auth 系统 schema。
const schemasEnv = (process.env.BACKUP_SCHEMAS || '').trim()

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
  return schemas
}

const backupSchemas = normalizeCompleteBackupSchemas(schemasEnv)
const schemaMode = backupSchemas.length > 0

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
  if (!DATABASE_URL) {
    console.error('Missing DATABASE_URL')
    process.exit(1)
  }
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
    console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
    process.exit(1)
  }

  const modeLabel = schemaMode
    ? `schemas [${backupSchemas.join(',')}]`
    : fullMode
      ? 'FULL'
      : 'trader tables'
  console.log(`[backup] Starting ${modeLabel} backup — ${now.toISOString()}`)

  const selectionArgs = schemaMode
    ? backupSchemas.flatMap((s) => ['-n', s])
    : fullMode
      ? [] // dump everything
      : TRADER_TABLES.flatMap((t) => ['-t', `public.${t}`])

  const modeSuffix = schemaMode ? '-schemas' : fullMode ? '-full' : ''
  const filename = `arena-backup-${dateStr}${modeSuffix}.sql.gz`
  const localPath = `/tmp/${filename}`

  try {
    // pg_dump → gzip (PostgreSQL 17 匹配 Supabase 服务器)
    // 路径可 env 覆盖：Mac 本机默认 Homebrew pg17；GH Actions 装 client 后设 PG_DUMP_PATH=pg_dump
    const pgDumpPath = process.env.PG_DUMP_PATH || '/opt/homebrew/opt/postgresql@17/bin/pg_dump'
    console.log(
      `[backup] Dumping ${schemaMode ? backupSchemas.join('+') + ' schemas' : fullMode ? 'full database' : `${TRADER_TABLES.length} tables`}...`
    )
    // 30 tables over network to Supabase can take 15-20min depending on
    // trader_snapshots_v2 size. 30min budget prevents false ETIMEDOUT.
    const { connectionUrl, password } = preparePgDumpConnection(DATABASE_URL)
    const minimumBytes = schemaMode || fullMode ? COMPLETE_BACKUP_MIN_BYTES : 1
    const completionToken = randomBytes(32).toString('hex')
    const r2Key = `db-backups/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${filename}`
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
        await s3.send(
          new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: r2Key,
            Body: createReadStream(localPath),
            ContentType: 'application/gzip',
            ContentLength: size,
            Metadata: {
              'backup-date': now.toISOString(),
              'backup-type': schemaMode
                ? `schemas:${backupSchemas.join('+')}`
                : fullMode
                  ? 'full'
                  : 'trader-tables',
              tables: schemaMode
                ? backupSchemas.join(',')
                : fullMode
                  ? 'all'
                  : TRADER_TABLES.join(','),
              'completion-contract': ARENA_BACKUP_COMPLETION_CONTRACT,
              'completion-token': completionToken,
            },
          })
        )
        console.log(`[backup] ✓ Uploaded successfully: ${r2Key} (${sizeMB} MB)`)
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

    const dateOf = (k) => (k.match(/arena-backup-(\d{8})/) || [])[1] || ''
    const isFull = (k) => k.includes('-full')
    const cutoffDate = new Date(Date.now() - DAILY_RETENTION_DAYS * 86_400_000)
    const cutoff = cutoffDate.toISOString().slice(0, 10).replace(/-/g, '')
    const keepFulls = new Set(
      all
        .filter((o) => isFull(o.Key))
        .sort((a, b) => dateOf(b.Key).localeCompare(dateOf(a.Key)))
        .slice(0, FULL_BACKUPS_TO_KEEP)
        .map((o) => o.Key)
    )
    const toDelete = all.filter((o) =>
      isFull(o.Key) ? !keepFulls.has(o.Key) : dateOf(o.Key) !== '' && dateOf(o.Key) < cutoff
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
