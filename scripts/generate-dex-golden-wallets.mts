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
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { config } from 'dotenv'
import { format } from 'prettier'

import { closeIngestPool, ingestClientConnect } from '../lib/ingest/db'
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
  const client = await ingestClientConnect()
  let transactionOpen = false
  try {
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
    client.release()
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown golden-wallet generator error'
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]')
    .split(/\r?\n/, 1)[0]
    .slice(0, 500)
}

async function main(): Promise<void> {
  const gitSha = cleanGitSha()
  try {
    const rows = await collectSnapshotRows()
    const candidates = buildDexGoldenWalletCandidates(rows)
    const { snapshot, sha256 } = buildDexGoldenWalletSnapshot({
      candidates,
      generatedAt: new Date().toISOString(),
      generatorGitSha: gitSha,
      sampleSeed: SAMPLE_SEED,
    })
    const output = await format(JSON.stringify(snapshot), { parser: 'json' })
    writeFileSync(OUTPUT_PATH, output, 'utf8')

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
  } finally {
    await closeIngestPool()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`)
  process.exitCode = 1
})
