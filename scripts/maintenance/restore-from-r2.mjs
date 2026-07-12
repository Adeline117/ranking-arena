#!/usr/bin/env node
/**
 * Restore an R2 database backup → a TARGET Postgres (2026-07-11).
 *
 * Counterpart to backup-to-r2.mjs. That script dumps `-n arena -n public`
 * as PLAIN SQL (`--no-owner --no-privileges`) → gzip → R2 at
 * `db-backups/YYYY/MM/arena-backup-<date>[-full].sql.gz`. Restore is therefore
 * just `gunzip | psql` against a target DB.
 *
 * SAFETY: refuses to run against the production DATABASE_URL unless
 * `--force-prod` is passed (a DR restore should target a FRESH Supabase project,
 * never overwrite the live one). Default target = RESTORE_TARGET_URL env.
 *
 * Usage:
 *   RESTORE_TARGET_URL=postgres://…/scratch node scripts/maintenance/restore-from-r2.mjs           # latest
 *   RESTORE_TARGET_URL=… node scripts/maintenance/restore-from-r2.mjs --key db-backups/2026/07/arena-backup-2026-07-10.sql.gz
 *   node scripts/maintenance/restore-from-r2.mjs --list                                            # list available, no restore
 *
 * Caveats (DR reality, see docs/RUNBOOK.md "Restore from R2"):
 *  - Dump is `--no-privileges` → RLS policies + grants are NOT in it. After a
 *    full-project restore, re-apply migrations (supabase db push) to get
 *    policies/grants back, OR restore into a project that already ran them.
 *  - Dump excludes `auth`/`storage` schemas (BACKUP_SCHEMAS=arena,public) →
 *    user accounts are NOT here; that's Supabase-managed (PITR). This restore
 *    recovers arena+public data only.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { execSync } from 'child_process'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), '.env.local') })

const args = process.argv.slice(2)
const LIST_ONLY = args.includes('--list')
const FORCE_PROD = args.includes('--force-prod')
const keyArg = (() => {
  const i = args.indexOf('--key')
  return i >= 0 ? args[i + 1] : null
})()

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET = process.env.R2_BUCKET || 'arena-backups'
const TARGET = process.env.RESTORE_TARGET_URL
const PROD = process.env.DATABASE_URL
const PSQL_PATH = process.env.PSQL_PATH || '/opt/homebrew/opt/postgresql@17/bin/psql'

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID) {
  console.error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)')
  process.exit(1)
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
})

async function listBackups() {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: 'db-backups/' }))
  return (out.Contents ?? [])
    .filter((o) => o.Key?.endsWith('.sql.gz'))
    .sort((a, b) => (a.LastModified > b.LastModified ? -1 : 1))
}

async function main() {
  const backups = await listBackups()
  if (backups.length === 0) {
    console.error('[restore] No .sql.gz backups found in R2 — backup pipeline may be broken')
    process.exit(1)
  }

  if (LIST_ONLY) {
    console.log(`[restore] ${backups.length} backups (newest first):`)
    for (const b of backups.slice(0, 20)) {
      console.log(`  ${b.Key}  ${(b.Size / 1e6).toFixed(1)}MB  ${b.LastModified.toISOString()}`)
    }
    return
  }

  if (!TARGET) {
    console.error('[restore] RESTORE_TARGET_URL not set. Refusing to guess a target.')
    console.error('           A DR restore should target a FRESH Supabase project, not prod.')
    process.exit(1)
  }
  if (TARGET === PROD && !FORCE_PROD) {
    console.error('[restore] REFUSING: RESTORE_TARGET_URL == DATABASE_URL (production).')
    console.error('           Restore to a scratch/fresh DB. Pass --force-prod only if you truly')
    console.error('           mean to overwrite production (you almost never do).')
    process.exit(1)
  }

  const key = keyArg || backups[0].Key
  console.log(`[restore] Source: ${R2_BUCKET}/${key}`)
  console.log(`[restore] Target: ${TARGET.replace(/:[^:@/]+@/, ':****@')}`)

  const localGz = join(tmpdir(), `arena-restore-${key.split('/').pop()}`)
  const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }))
  await pipeline(obj.Body, createWriteStream(localGz))
  console.log(`[restore] Downloaded → ${localGz}`)

  // Plain-SQL restore: gunzip | psql. ON_ERROR_STOP so a broken dump fails loud.
  console.log('[restore] Applying (gunzip | psql, ON_ERROR_STOP)…')
  execSync(`gunzip -c "${localGz}" | ${PSQL_PATH} "${TARGET}" -v ON_ERROR_STOP=1 --quiet`, {
    stdio: 'inherit',
  })

  // Verification: row counts on the primary tables.
  console.log('[restore] Verifying row counts…')
  const verify = execSync(
    `${PSQL_PATH} "${TARGET}" -t -A -c "` +
      `SELECT 'arena.traders='||count(*) FROM arena.traders UNION ALL ` +
      `SELECT 'arena.trader_stats='||count(*) FROM arena.trader_stats UNION ALL ` +
      `SELECT 'public.leaderboard_ranks='||count(*) FROM public.leaderboard_ranks UNION ALL ` +
      `SELECT 'public.posts='||count(*) FROM public.posts"`,
    { encoding: 'utf8' }
  )
  console.log(verify.trim())
  console.log('[restore] DONE. NOTE: policies/grants (--no-privileges) and auth schema are')
  console.log(
    '          NOT in this dump — re-apply migrations for RLS, and auth is Supabase PITR.'
  )
}

main().catch((e) => {
  console.error('[restore] FAILED:', e.message)
  process.exit(1)
})
