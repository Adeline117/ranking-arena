/**
 * Freeze the Phase 0 BSC + Solana golden-wallet sample from production.
 *
 * The source population is the latest count-gate-passed 90D leaderboard
 * snapshot for each source. Every selection field comes from that exact board
 * observation; arena.trader_stats is intentionally excluded because it is a
 * mutable mixed-width latest row, not immutable snapshot evidence.
 *
 * Usage:  npm run census:dex:golden-wallets
 * Writes: scripts/fixtures/dex-golden-wallets.v1.json
 */

import { execFileSync } from 'node:child_process'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { config } from 'dotenv'
import { Client } from 'pg'
import { format } from 'prettier'

import {
  buildDexGoldenWalletCandidates,
  DEX_GOLDEN_SOURCES,
  type DexGoldenWalletQueryRow,
} from './lib/dex-golden-wallet-query'
import { buildDexGoldenWalletSnapshot } from './lib/dex-golden-wallets'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true, override: false })

const SAMPLE_SEED = 'arena-dex-golden-wallets-v1-2026-07-16'
const OUTPUT_PATH = join(process.cwd(), 'scripts', 'fixtures', 'dex-golden-wallets.v1.json')

const CANDIDATE_QUERY = `
WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (s.slug)
         s.slug,
         s.id AS source_id,
         s.currency AS source_currency,
         s.meta->>'chain_id' AS source_meta_chain_id,
         ls.id::text AS snapshot_id,
         ls.scraped_at AS snapshot_scraped_at,
         ls.actual_count AS snapshot_actual_count,
         ls.is_derived
    FROM arena.sources s
    JOIN arena.leaderboard_snapshots ls
      ON ls.source_id = s.id
   WHERE s.slug = ANY($1::text[])
     AND s.status = 'active'
     AND s.serving_mode = 'serving'
     AND ls.timeframe = 90
     AND ls.count_check_passed
   ORDER BY s.slug, ls.scraped_at DESC, ls.id DESC
)
SELECT l.slug AS source_slug,
       l.source_currency,
       le.currency AS entry_currency,
       l.source_meta_chain_id,
       l.snapshot_id,
       l.snapshot_scraped_at,
       l.snapshot_actual_count,
       l.is_derived,
       t.wallet_address,
       t.exchange_trader_id,
       le.rank AS source_rank,
       le.headline_pnl::text AS pnl_90d_raw,
       CASE
         WHEN l.slug = 'binance_web3_bsc'
           THEN jsonb_typeof(le.raw->'totalTxCnt')
         ELSE jsonb_typeof(le.raw->'tx')
       END AS activity_json_type,
       CASE
         WHEN l.slug = 'binance_web3_bsc'
           THEN le.raw->>'totalTxCnt'
         ELSE le.raw->>'tx'
       END AS activity_total_raw,
       jsonb_typeof(le.raw->'buyTxCnt') AS activity_buy_json_type,
       le.raw->>'buyTxCnt' AS activity_buy_raw,
       jsonb_typeof(le.raw->'sellTxCnt') AS activity_sell_json_type,
       le.raw->>'sellTxCnt' AS activity_sell_raw,
       le.raw->>'periodType' AS period_type,
       le.raw->>'chainId' AS raw_chain_id
  FROM latest l
  JOIN arena.leaderboard_entries le
    ON le.snapshot_id = l.snapshot_id::bigint
   AND le.scraped_at = l.snapshot_scraped_at
   AND le.timeframe = 90
  JOIN arena.traders t
    ON t.id = le.trader_id
   AND t.source_id = l.source_id
 ORDER BY l.slug, le.rank, t.exchange_trader_id`

function cleanGitSha(): string {
  const cwd = process.cwd()
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  if (status) throw new Error('Refusing to generate golden wallets from a dirty Git worktree')

  const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Git HEAD is not a full lowercase SHA')
  return sha
}

async function collectSnapshotRows(): Promise<DexGoldenWalletQueryRow[]> {
  const databaseUrl = process.env.INGEST_DATABASE_URL ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('Production database URL is not configured')
  const isLocal = databaseUrl.includes('127.0.0.1') || databaseUrl.includes('localhost')
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ranking-arena-golden-wallet-readonly',
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  })
  const suppressUnstructuredClientError = () => {
    // The query rejection is sanitized by the CLI boundary below.
  }
  client.on('error', suppressUnstructuredClientError)
  let connected = false
  let transactionOpen = false
  try {
    await client.connect()
    connected = true
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    await client.query("SET LOCAL statement_timeout = '45s'")
    await client.query("SET LOCAL lock_timeout = '5s'")
    const { rows } = await client.query<DexGoldenWalletQueryRow>(CANDIDATE_QUERY, [
      [...DEX_GOLDEN_SOURCES],
    ])
    await client.query('COMMIT')
    transactionOpen = false
    return rows
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original read/query error; no production writes occurred.
      }
    }
    throw error
  } finally {
    if (connected) await client.end().catch(() => undefined)
    client.removeListener('error', suppressUnstructuredClientError)
  }
}

function writeFixtureAtomically(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  let fileDescriptor: number | null = null
  try {
    fileDescriptor = openSync(temporaryPath, 'wx', 0o644)
    writeFileSync(fileDescriptor, contents, 'utf8')
    fsyncSync(fileDescriptor)
    closeSync(fileDescriptor)
    fileDescriptor = null
    renameSync(temporaryPath, path)
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor)
      } catch {
        // Best-effort cleanup; preserve the original write error.
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown golden-wallet generator error'
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]')
    .replace(/0x[0-9a-f]{40}/gi, '[redacted-wallet]')
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '[redacted-wallet]')
    .split(/\r?\n/, 1)[0]
    .slice(0, 500)
}

async function main(): Promise<void> {
  const gitSha = cleanGitSha()
  const rows = await collectSnapshotRows()
  const candidates = buildDexGoldenWalletCandidates(rows)
  const { snapshot, sha256 } = buildDexGoldenWalletSnapshot({
    candidates,
    generatedAt: new Date().toISOString(),
    generatorGitSha: gitSha,
    sampleSeed: SAMPLE_SEED,
  })
  const output = await format(JSON.stringify(snapshot), { parser: 'json' })
  writeFixtureAtomically(OUTPUT_PATH, output)

  const counts = Object.fromEntries(
    DEX_GOLDEN_SOURCES.map((source) => [
      source,
      snapshot.wallets.filter((wallet) => wallet.source_slug === source).length,
    ])
  )
  process.stdout.write(
    `wrote golden-wallet fixture: total=${snapshot.wallets.length}, ` +
      `bsc=${counts.binance_web3_bsc}, solana=${counts.okx_web3_solana}, ` +
      `sha256=${sha256}\n`
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`)
  process.exitCode = 1
})
