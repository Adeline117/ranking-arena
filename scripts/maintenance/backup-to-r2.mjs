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

import { execSync } from 'child_process'
import { createReadStream, statSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import 'dotenv/config'

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
const schemaMode = schemasEnv.length > 0
const backupSchemas = schemaMode
  ? schemasEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : []

/**
 * Keep database credentials out of pg_dump's argv. libpq accepts the password
 * through PGPASSWORD, while the remaining URI (including SSL/query settings)
 * stays as the database argument.
 */
export function preparePgDumpConnection(databaseUrl) {
  let parsedUrl
  try {
    parsedUrl = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL')
  }

  if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol')
  }

  const decodePassword = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new Error('DATABASE_URL password has invalid percent-encoding')
    }
  }

  const authorityStart = databaseUrl.indexOf('://') + 3
  const authorityEndOffset = databaseUrl.slice(authorityStart).search(/[/?#]/)
  const authorityEnd =
    authorityEndOffset === -1 ? databaseUrl.length : authorityStart + authorityEndOffset
  const authority = databaseUrl.slice(authorityStart, authorityEnd)
  const atIndex = authority.lastIndexOf('@')
  const userInfo = atIndex >= 0 ? authority.slice(0, atIndex) : ''
  const passwordSeparator = userInfo.indexOf(':')
  const hasAuthorityPassword = passwordSeparator >= 0
  const authorityPassword = hasAuthorityPassword
    ? decodePassword(userInfo.slice(passwordSeparator + 1))
    : undefined
  const sanitizedAuthority = hasAuthorityPassword
    ? `${userInfo.slice(0, passwordSeparator)}${authority.slice(atIndex)}`
    : authority

  // Query parameters are parsed after the authority by libpq, so an explicit
  // ?password= value takes precedence over user:password@host. Preserve that
  // behavior while removing every password occurrence from the public argv.
  // Work on the raw query so unrelated libpq values such as `a+b` are not
  // normalized by URLSearchParams and retain their exact connection meaning.
  const remainder = databaseUrl.slice(authorityEnd)
  const fragmentIndex = remainder.indexOf('#')
  const beforeFragment = fragmentIndex === -1 ? remainder : remainder.slice(0, fragmentIndex)
  const fragment = fragmentIndex === -1 ? '' : remainder.slice(fragmentIndex)
  const queryIndex = beforeFragment.indexOf('?')
  const path = queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? null : beforeFragment.slice(queryIndex + 1)
  const queryPasswords = []
  const safeQueryParts = []

  if (rawQuery !== null) {
    for (const part of rawQuery.split('&')) {
      const separator = part.indexOf('=')
      const rawKey = separator === -1 ? part : part.slice(0, separator)
      if (decodePassword(rawKey) === 'password') {
        queryPasswords.push(decodePassword(separator === -1 ? '' : part.slice(separator + 1)))
      } else {
        safeQueryParts.push(part)
      }
    }
  }

  const safeQuery = safeQueryParts.length > 0 ? `?${safeQueryParts.join('&')}` : ''
  const password = queryPasswords.length > 0 ? queryPasswords.at(-1) : authorityPassword

  return {
    connectionUrl: `${databaseUrl.slice(0, authorityStart)}${sanitizedAuthority}${path}${safeQuery}${fragment}`,
    password,
  }
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

  const tableArgs = schemaMode
    ? backupSchemas.map((s) => `-n ${s}`).join(' ')
    : fullMode
      ? '' // dump everything
      : TRADER_TABLES.map((t) => `-t public.${t}`).join(' ')

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
    const pgDumpEnv =
      password === undefined ? process.env : { ...process.env, PGPASSWORD: password }
    execSync(
      `${pgDumpPath} "${connectionUrl}" ${tableArgs} --no-owner --no-privileges | gzip > ${localPath}`,
      { env: pgDumpEnv, stdio: ['pipe', 'pipe', 'pipe'], timeout: 1_800_000 }
    )

    const size = statSync(localPath).size
    const sizeMB = (size / 1024 / 1024).toFixed(1)
    console.log(`[backup] Dump complete: ${sizeMB} MB`)

    // Upload to R2
    const r2Key = `db-backups/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${filename}`
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
          tables: schemaMode ? backupSchemas.join(',') : fullMode ? 'all' : TRADER_TABLES.join(','),
        },
      })
    )

    console.log(`[backup] ✓ Uploaded successfully: ${r2Key} (${sizeMB} MB)`)

    // Cleanup local file
    unlinkSync(localPath)

    await pruneOldBackups()
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
