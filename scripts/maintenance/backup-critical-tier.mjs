#!/usr/bin/env node

/**
 * Critical-tier database backup: the data that cannot be re-derived.
 *
 * The production database is ~90 GB, almost all of it pipeline-ingested market
 * data (the `arena` schema, position-history partitions, equity curves,
 * leaderboards) that the ingest worker can rebuild. The irreplaceable part —
 * accounts, auth identities, posts, groups, subscriptions, follows — is on the
 * order of 100 MB. A full dump needs ~80 GB of staging and a CI runner; this
 * tier fits anywhere and takes seconds, so it can run before every release
 * window even when the full-backup path is unavailable.
 *
 *   BACKUP_PASSPHRASE=… DATABASE_URL=… node scripts/maintenance/backup-critical-tier.mjs backup --out <dir>
 *   BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs verify <file>
 *   BACKUP_PASSPHRASE=… node scripts/maintenance/backup-critical-tier.mjs decrypt <file> <out.dump>
 *
 * Output is `pg_dump --format=custom` of the `public` and `auth` schemas with
 * the rows of the derived tables excluded (their definitions are kept), then
 * AES-256-GCM encrypted. Plaintext never touches disk. It is NOT a full
 * disaster-recovery image: restoring it yields users and content with empty
 * market tables, to be refilled by the pipeline.
 */

import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { preparePostgresConnection } from './backup-restore-contract.mjs'
import { cleanPostgresConnectionEnv } from './postgres-cli-env.mjs'

export const CRITICAL_SCHEMAS = Object.freeze(['public', 'auth'])

/**
 * Tables whose ROWS are pipeline-derived and excluded (definitions are kept).
 * Explicit names only — a `trader_*` wildcard would also drop trader_follows
 * and trader_watchlist, which are user data.
 */
export const DERIVED_TABLE_DATA_PATTERNS = Object.freeze([
  'public.tph_*',
  'public.trader_position_history*',
  'public.trader_equity_curve',
  'public.trader_stats_detail',
  'public.trader_portfolio',
  'public.trader_daily_snapshots',
  'public.trader_sources',
  'public.trader_asset_breakdown',
  'public.trader_profiles_v2',
  'public.leaderboard_ranks*',
  'public.lr_7d',
  'public.lr_30d',
  'public.lr_90d',
  'public.rank_history',
  'public.flash_news',
  'public.pipeline_logs',
  'public.product_events',
])

/** Relations whose data must be present for the artifact to count as a backup. */
export const REQUIRED_TABLE_DATA = Object.freeze([
  'auth users',
  'auth identities',
  'public user_profiles',
  'public posts',
  'public comments',
  'public groups',
  'public group_members',
  'public subscriptions',
  'public trader_follows',
])

export const MIN_PASSPHRASE_LENGTH = 32
const MAGIC = Buffer.from('ARENACT1')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES

export function buildPgDumpArgs() {
  return [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    ...CRITICAL_SCHEMAS.map((schema) => `--schema=${schema}`),
    ...DERIVED_TABLE_DATA_PATTERNS.map((pattern) => `--exclude-table-data=${pattern}`),
  ]
}

export function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters`)
  }
  return passphrase
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
}

/** Encrypt a readable stream to `outputPath` (header ‖ ciphertext ‖ GCM tag). */
export async function encryptStreamToFile(source, outputPath, passphrase) {
  assertPassphrase(passphrase)
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  cipher.setAAD(MAGIC)
  const output = createWriteStream(outputPath, { mode: 0o600, flags: 'wx' })
  output.write(Buffer.concat([MAGIC, salt, iv]))
  await pipeline(source, cipher, output, { end: false })
  await new Promise((resolveWrite, rejectWrite) => {
    output.once('error', rejectWrite)
    output.end(cipher.getAuthTag(), resolveWrite)
  })
}

/** Decrypt `inputPath` into a writable; rejects on a wrong key or any tampering. */
export async function decryptFileToStream(inputPath, destination, passphrase) {
  assertPassphrase(passphrase)
  const { size } = statSync(inputPath)
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('backup file is truncated')
  const fd = openSync(inputPath, 'r')
  const header = Buffer.alloc(HEADER_BYTES)
  const tag = Buffer.alloc(TAG_BYTES)
  try {
    readSync(fd, header, 0, HEADER_BYTES, 0)
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES)
  } finally {
    closeSync(fd)
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a critical-tier backup file')
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES)
  const iv = header.subarray(MAGIC.length + SALT_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  const body = createReadStream(inputPath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 })
  await pipeline(body, decipher, destination)
}

/** Parse `pg_restore --list` output into the set of "schema table" data entries. */
export function parseTableDataEntries(listing) {
  const entries = new Set()
  for (const line of listing.split('\n')) {
    const match = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line)
    if (match) entries.add(`${match[1]} ${match[2]}`)
  }
  return entries
}

export function assertCriticalCoverage(entries) {
  const missing = REQUIRED_TABLE_DATA.filter((relation) => !entries.has(relation))
  if (missing.length > 0) {
    throw new Error(`backup is missing data for: ${missing.join(', ')}`)
  }
  const leaked = [...entries].filter((entry) =>
    DERIVED_TABLE_DATA_PATTERNS.some((pattern) => {
      const [schema, table] = pattern.split('.')
      const [entrySchema, entryTable] = entry.split(' ')
      return (
        schema === entrySchema &&
        (table.endsWith('*') ? entryTable.startsWith(table.slice(0, -1)) : entryTable === table)
      )
    })
  )
  if (leaked.length > 0) {
    throw new Error(`derived table data was not excluded: ${leaked.join(', ')}`)
  }
}

function waitForExit(child, label) {
  return new Promise((resolveExit, rejectExit) => {
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.once('error', rejectExit)
    child.once('close', (code) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`${label} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

function pgBinary(name) {
  const dir = process.env.PG_BIN
  return dir ? join(dir, name) : name
}

export async function verifyBackupFile(filePath, passphrase) {
  const restore = spawn(pgBinary('pg_restore'), ['--list'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let listing = ''
  restore.stdout.on('data', (chunk) => {
    listing += chunk
  })
  const exited = waitForExit(restore, 'pg_restore --list')
  await decryptFileToStream(filePath, restore.stdin, passphrase)
  await exited
  const entries = parseTableDataEntries(listing)
  assertCriticalCoverage(entries)
  return { tableDataEntries: entries.size }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

export async function runBackup({ databaseUrl, passphrase, outDir, now = new Date() }) {
  assertPassphrase(passphrase)
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const { connectionUrl, password } = preparePostgresConnection(databaseUrl, 'DATABASE_URL')
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const finalPath = join(outDir, `arena-critical-${stamp}.dump.enc`)
  const partialPath = `${finalPath}.partial`
  if (existsSync(finalPath)) throw new Error(`refusing to overwrite ${finalPath}`)

  // pg_dump expands a connection URI only from --dbname, never from the
  // PGDATABASE variable (which it reads as a literal database name). The URI
  // passed here has its password stripped; the password travels in the env.
  const env = cleanPostgresConnectionEnv(
    process.env,
    password === undefined ? {} : { PGPASSWORD: password }
  )
  for (const name of ['DATABASE_URL', 'BACKUP_PASSPHRASE']) delete env[name]

  const dump = spawn(pgBinary('pg_dump'), [...buildPgDumpArgs(), `--dbname=${connectionUrl}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = waitForExit(dump, 'pg_dump')
  try {
    await Promise.all([encryptStreamToFile(dump.stdout, partialPath, passphrase), exited])
    const verification = await verifyBackupFile(partialPath, passphrase)
    renameSync(partialPath, finalPath)
    return {
      file: finalPath,
      bytes: statSync(finalPath).size,
      sha256: await sha256File(finalPath),
      ...verification,
    }
  } catch (error) {
    dump.kill('SIGKILL')
    if (existsSync(partialPath)) unlinkSync(partialPath)
    throw error
  }
}

async function main(argv) {
  const [command, ...rest] = argv
  const passphrase = process.env.BACKUP_PASSPHRASE
  if (command === 'backup') {
    const outIndex = rest.indexOf('--out')
    if (outIndex === -1 || !rest[outIndex + 1]) throw new Error('backup requires --out <dir>')
    const result = await runBackup({
      databaseUrl: process.env.DATABASE_URL,
      passphrase,
      outDir: resolve(rest[outIndex + 1]),
    })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'verify' && rest[0]) {
    console.log(JSON.stringify(await verifyBackupFile(resolve(rest[0]), passphrase), null, 2))
  } else if (command === 'decrypt' && rest[0] && rest[1]) {
    const output = createWriteStream(resolve(rest[1]), { mode: 0o600, flags: 'wx' })
    await decryptFileToStream(resolve(rest[0]), output, passphrase)
  } else {
    throw new Error('usage: backup --out <dir> | verify <file> | decrypt <file> <out.dump>')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`critical-tier backup failed: ${error.message}`)
    process.exit(1)
  })
}
