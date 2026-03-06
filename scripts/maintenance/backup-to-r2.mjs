#!/usr/bin/env node

/**
 * Long-term database backup to Cloudflare R2
 *
 * Dumps critical tables → gzip → upload to R2
 * Run weekly via cron or manually: node scripts/maintenance/backup-to-r2.mjs
 *
 * Requires: DATABASE_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 */

import { execSync } from 'child_process'
import { createReadStream, statSync, unlinkSync } from 'fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import 'dotenv/config'

const CRITICAL_TABLES = [
  'trader_equity_curve',
  'trader_snapshots',
  'trader_sources',
  'daily_trader_stats',
  'trader_position_history',
  'leaderboard_ranks',
  'leaderboard_snapshots',
  'trader_snapshots_v2',
  'trader_stats_detail',
  'trader_asset_breakdown',
  'trader_profiles_v2',
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
  console.log(`[backup] Starting ${fullMode ? 'FULL' : 'critical tables'} backup — ${now.toISOString()}`)

  const tableArgs = fullMode
    ? '' // dump everything
    : CRITICAL_TABLES.map(t => `-t public.${t}`).join(' ')

  const filename = `arena-backup-${dateStr}${fullMode ? '-full' : ''}.sql.gz`
  const localPath = `/tmp/${filename}`

  try {
    // pg_dump → gzip
    console.log(`[backup] Dumping${fullMode ? ' full database' : ` ${CRITICAL_TABLES.length} tables`}...`)
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
        'backup-type': fullMode ? 'full' : 'critical-tables',
        'tables': fullMode ? 'all' : CRITICAL_TABLES.join(','),
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
