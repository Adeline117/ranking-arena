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
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import 'dotenv/config'

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
  'trader_reviews',
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
  console.log(`[backup] Starting ${fullMode ? 'FULL' : 'trader tables'} backup — ${now.toISOString()}`)

  const tableArgs = fullMode
    ? '' // dump everything
    : TRADER_TABLES.map(t => `-t public.${t}`).join(' ')

  const filename = `arena-backup-${dateStr}${fullMode ? '-full' : ''}.sql.gz`
  const localPath = `/tmp/${filename}`

  try {
    // pg_dump → gzip
    console.log(`[backup] Dumping${fullMode ? ' full database' : ` ${TRADER_TABLES.length} tables`}...`)
    execSync(
      `pg_dump "${DATABASE_URL}" ${tableArgs} --no-owner --no-privileges | gzip > ${localPath}`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 600_000 }
    )

    const size = statSync(localPath).size
    const sizeMB = (size / 1024 / 1024).toFixed(1)
    console.log(`[backup] Dump complete: ${sizeMB} MB`)

    // Upload to R2
    const r2Key = `db-backups/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${filename}`
    console.log(`[backup] Uploading to R2: ${R2_BUCKET}/${r2Key}`)

    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: createReadStream(localPath),
      ContentType: 'application/gzip',
      ContentLength: size,
      Metadata: {
        'backup-date': now.toISOString(),
        'backup-type': fullMode ? 'full' : 'trader-tables',
        'tables': fullMode ? 'all' : TRADER_TABLES.join(','),
      },
    }))

    console.log(`[backup] ✓ Uploaded successfully: ${r2Key} (${sizeMB} MB)`)

    // Cleanup local file
    unlinkSync(localPath)
  } catch (err) {
    console.error(`[backup] ✗ Failed:`, err.message)
    try { unlinkSync(localPath) } catch {}
    process.exit(1)
  }
}

run()
