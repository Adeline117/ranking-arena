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

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL')
  process.exit(1)
}
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
  console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
  process.exit(1)
}

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

async function run() {
  console.log(
    `[backup] Starting ${fullMode ? 'FULL' : 'trader tables'} backup — ${now.toISOString()}`
  )

  const tableArgs = fullMode
    ? '' // dump everything
    : TRADER_TABLES.map((t) => `-t public.${t}`).join(' ')

  const filename = `arena-backup-${dateStr}${fullMode ? '-full' : ''}.sql.gz`
  const localPath = `/tmp/${filename}`

  try {
    // pg_dump → gzip (使用 PostgreSQL 17 版本以匹配 Supabase 服务器)
    const pgDumpPath = '/opt/homebrew/opt/postgresql@17/bin/pg_dump'
    console.log(
      `[backup] Dumping${fullMode ? ' full database' : ` ${TRADER_TABLES.length} tables`}...`
    )
    // 30 tables over network to Supabase can take 15-20min depending on
    // trader_snapshots_v2 size. 30min budget prevents false ETIMEDOUT.
    execSync(
      `${pgDumpPath} "${DATABASE_URL}" ${tableArgs} --no-owner --no-privileges | gzip > ${localPath}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 1_800_000 }
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
          'backup-type': fullMode ? 'full' : 'trader-tables',
          tables: fullMode ? 'all' : TRADER_TABLES.join(','),
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

run()
